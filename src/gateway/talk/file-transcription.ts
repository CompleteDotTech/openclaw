import fs from "node:fs/promises";
import path from "node:path";
import { normalizeMediaProviderId } from "../../../packages/media-understanding-common/src/provider-id.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { MediaUnderstandingProvider } from "../../media-understanding/provider-types.js";
import {
  probeRestrictedAudioRoute,
  RestrictedAudioError,
  transcribeRestrictedAudio,
} from "../../media-understanding/restricted-audio.js";
import type { RealtimeTranscriptionSessionCallbacks } from "../../realtime-transcription/provider-types.js";
import { resolveTalkSessionAgentId } from "../../talk/agent-target.js";
import { mulawToPcmInto } from "../../talk/audio-codec.js";
import type { TalkSpeechDataPlan } from "./speech-data-policy.js";

export type TalkFileTranscriptionConfig = {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  maxBytes: number;
  ready: boolean;
  provider?: string;
  providers: Array<{ id: string; models: string[]; configured: boolean }>;
  speechData?: TalkSpeechDataPlan;
};

/** The selected restricted route uses the same file-session owner without plugin discovery. */
export async function resolveRestrictedTalkFileTranscriptionConfig(
  cfg: OpenClawConfig,
  agentId: string | undefined,
  plan: TalkSpeechDataPlan,
  assertCurrent: () => void,
): Promise<TalkFileTranscriptionConfig> {
  const resolvedAgentId = agentId ?? resolveTalkSessionAgentId(cfg);
  const probe = plan.route
    ? await probeRestrictedAudioRoute({ route: plan.route, assertCurrent })
    : undefined;
  const readiness = probe
    ? {
        ...plan.readiness,
        configured: probe.configured,
        initialized: probe.initialized,
        available: probe.available,
        permitted: probe.permitted,
        reason: probe.error?.code ?? "model-advertised",
        message:
          probe.error?.message ??
          "The approved endpoint advertises this model. Recognition and model initialization remain unverified; processing is on the Gateway's chosen endpoint.",
      }
    : plan.readiness;
  return {
    cfg,
    agentId: resolvedAgentId,
    agentDir: resolveAgentDir(cfg, resolvedAgentId),
    workspaceDir: resolveAgentWorkspaceDir(cfg, resolvedAgentId),
    maxBytes: plan.maxBytes,
    ready: readiness.available && readiness.permitted,
    provider: readiness.provider,
    providers: readiness.provider
      ? [
          {
            id: readiness.provider,
            models: readiness.model ? [readiness.model] : [],
            configured: readiness.configured,
          },
        ]
      : [],
    speechData: { ...plan, readiness },
  };
}

/** Explicit file models use the same selection and input budget as uploaded voice notes. */
export async function resolveTalkFileTranscriptionConfig(
  cfg: OpenClawConfig,
  agentId?: string,
): Promise<TalkFileTranscriptionConfig | undefined> {
  if (!cfg.tools?.media?.models?.length || cfg.tools.media.audio?.enabled === false) {
    return undefined;
  }
  const [{ resolvePluginCapabilityProvider }, { resolveModelEntries, resolveMaxBytes }] =
    await Promise.all([
      import("../../plugins/capability-provider-runtime.js"),
      import("../../media-understanding/resolve.js"),
    ]);
  const registry = new Map<string, MediaUnderstandingProvider>();
  // File transcription only uses configured models; don't discover unrelated media plugins.
  for (const providerId of new Set(
    cfg.tools.media.models.flatMap(({ provider }) =>
      provider ? [normalizeMediaProviderId(provider)] : [],
    ),
  )) {
    const provider = resolvePluginCapabilityProvider({
      key: "mediaUnderstandingProviders",
      providerId,
      cfg,
    });
    if (provider) {
      registry.set(normalizeMediaProviderId(provider.id), provider);
    }
  }
  const entries = resolveModelEntries({
    cfg,
    capability: "audio",
    config: cfg.tools.media.audio,
    providerRegistry: registry,
  });
  if (entries.length === 0) {
    return undefined;
  }
  const resolvedAgentId = agentId ?? resolveTalkSessionAgentId(cfg);
  const scope = {
    agentId: resolvedAgentId,
    agentDir: resolveAgentDir(cfg, resolvedAgentId),
    workspaceDir: resolveAgentWorkspaceDir(cfg, resolvedAgentId),
  };
  const { isAudioModelEntryAvailable } =
    await import("../../media-understanding/provider-execution.js");
  const providers = new Map<string, { models: string[]; configured: boolean }>();
  const providerId = (id: string) => registry.get(normalizeMediaProviderId(id))?.id ?? id;
  let ready = false;
  let maxBytes = 0;
  let selectedProvider: string | undefined;
  for (const { entry, secretOwnerId } of entries) {
    maxBytes = Math.max(
      maxBytes,
      resolveMaxBytes({ cfg, capability: "audio", config: cfg.tools.media.audio, entry }),
    );
    const configured = await isAudioModelEntryAvailable({
      cfg,
      ...scope,
      entry,
      secretOwnerId,
      providerRegistry: registry,
    });
    if (configured && !ready) {
      selectedProvider = entry.provider ? providerId(entry.provider) : undefined;
    }
    ready ||= configured;
    if (!entry.provider) {
      continue;
    }
    const id = providerId(entry.provider);
    const state = providers.get(id) ?? { models: [], configured: false };
    state.configured ||= configured;
    if (entry.model && !state.models.includes(entry.model)) {
      state.models.push(entry.model);
    }
    providers.set(id, state);
  }
  return {
    cfg,
    ...scope,
    maxBytes,
    ready,
    provider: selectedProvider,
    providers: Array.from(providers, ([id, state]) => ({ id, ...state })),
  };
}

function encodeWav(audio: Buffer): Buffer {
  const pcmBytes = audio.length * 2;
  const wav = Buffer.alloc(44 + pcmBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcmBytes, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcmBytes, 40);
  mulawToPcmInto(audio, wav.subarray(44));
  return wav;
}

/** Adapts the browser's existing audio frames to the file-transcription owner. */
export function createTalkFileTranscriptionSession(
  config: TalkFileTranscriptionConfig,
  callbacks: RealtimeTranscriptionSessionCallbacks,
  assertCurrent: () => void,
) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const cancellation = new AbortController();
  return {
    connect: () => Promise.resolve(),
    sendAudio(audio: Buffer) {
      if (cancellation.signal.aborted) {
        throw new Error("Transcription session is closed");
      }
      assertCurrent();
      if ((bytes + audio.length) * 2 + 44 > config.maxBytes) {
        throw new Error(`Transcription audio exceeds the configured ${config.maxBytes} byte limit`);
      }
      chunks.push(audio);
      bytes += audio.length;
    },
    close() {
      cancellation.abort();
      chunks.length = 0;
      bytes = 0;
    },
    async finish() {
      if (cancellation.signal.aborted || bytes === 0) {
        return;
      }
      // Snapshot borrowed frames before yielding; decode after directory setup to preserve I/O overlap.
      const audio = Buffer.concat(chunks, bytes);
      chunks.length = 0;
      bytes = 0;
      if (config.speechData) {
        const { route, language, prompt, timeoutMs } = config.speechData;
        if (!route) {
          throw new RestrictedAudioError("route-denied");
        }
        assertCurrent();
        const result = await transcribeRestrictedAudio({
          route,
          buffer: encodeWav(audio),
          signal: cancellation.signal,
          assertCurrent,
          language,
          prompt,
          timeoutMs,
        });
        if (!cancellation.signal.aborted) {
          assertCurrent();
          callbacks.onTranscript?.(result.text);
        }
        return;
      }
      const root = resolvePreferredOpenClawTmpDir();
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await fs.mkdtemp(path.join(root, "talk-stt-"));
      try {
        const filePath = path.join(directory, "speech.wav");
        await fs.writeFile(filePath, encodeWav(audio), { mode: 0o600 });
        const { transcribeAudioFile } = await import("../../media-understanding/runtime.js");
        if (cancellation.signal.aborted) {
          return;
        }
        assertCurrent();
        const result = await transcribeAudioFile(
          {
            cfg: config.cfg,
            agentId: config.agentId,
            agentDir: config.agentDir,
            workspaceDir: config.workspaceDir,
            filePath,
            mime: "audio/wav",
          },
          { signal: cancellation.signal, assertCurrent },
        );
        if (!cancellation.signal.aborted) {
          assertCurrent();
          callbacks.onTranscript?.(result.text ?? "");
        }
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  };
}
