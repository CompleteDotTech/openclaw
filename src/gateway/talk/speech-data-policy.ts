import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import type { OpenClawConfig } from "../../config/types.js";
import { resolveConfiguredMediaEntryCapabilities } from "../../media-understanding/entry-capabilities.js";
import { resolveProviderRequestContext } from "../../media-understanding/provider-execution.js";
import { resolveEntryRunOptions, resolveModelEntries } from "../../media-understanding/resolve.js";
import {
  RestrictedAudioError,
  resolveRestrictedAudioRoute,
  type RestrictedAudioRoute,
} from "../../media-understanding/restricted-audio.js";
import { resolveEffectivePluginActivationState } from "../../plugins/config-state.js";

export type TalkSpeechDataReadiness = {
  mode: "device-local" | "trusted-endpoint";
  configured: boolean;
  initialized: boolean;
  available: boolean;
  permitted: boolean;
  transport: "batch";
  provider?: string;
  model?: string;
  destination?: string;
  reason: string;
  message: string;
  refinement: "unavailable";
};

export type TalkSpeechDataPlan = {
  readiness: TalkSpeechDataReadiness;
  route?: RestrictedAudioRoute;
  maxBytes: number;
  timeoutMs: number;
  language?: string;
  prompt?: string;
};

// The relay emits 8 kHz mu-law and the file owner expands it to mono PCM16 WAV.
const MAX_RESTRICTED_WAV_BYTES = 44 + 120 * 8_000 * 2;

export function isTalkSpeechDataRestricted(config: OpenClawConfig): boolean {
  const policy = config.talk?.speechDataPolicy;
  return policy !== undefined && policy.mode !== "external";
}

/** No provider hooks or credential discovery may run before this admission. */
export function resolveTalkSpeechDataPlan(
  config: OpenClawConfig,
  selection: { streamingSelected: boolean; requestedProvider?: string; requestedModel?: string },
): TalkSpeechDataPlan {
  const policy = config.talk?.speechDataPolicy;
  const readiness: TalkSpeechDataReadiness = {
    mode: policy?.mode === "device-local" ? "device-local" : "trusted-endpoint",
    configured: false,
    initialized: false,
    available: false,
    permitted: false,
    transport: "batch",
    reason: "route-denied",
    message: "Choose a supported explicit speech endpoint before recording.",
    refinement: "unavailable",
  };
  const unavailable = (reason: string, message: string): TalkSpeechDataPlan => ({
    readiness: { ...readiness, reason, message },
    maxBytes: MAX_RESTRICTED_WAV_BYTES,
    timeoutMs: 60_000,
  });
  if (policy?.mode === "device-local") {
    return unavailable(
      "device-unverified",
      "No adapter has verified inference on the microphone device. A Gateway loopback server is a separate trusted endpoint.",
    );
  }
  if (policy?.mode !== "trusted-endpoint") {
    return unavailable("route-denied", "This speech policy is not supported by this runtime.");
  }
  if (selection.requestedProvider?.trim() || selection.requestedModel?.trim()) {
    return unavailable(
      "override-denied",
      "Restricted dictation uses the configured speech route. Request overrides are unavailable; review settings and start a new recording.",
    );
  }
  if (selection.streamingSelected) {
    return unavailable(
      "adapter-unavailable",
      "The selected streaming or voice-model route cannot enforce this speech policy. Select the supported media audio route before recording.",
    );
  }
  if (config.proxy?.enabled) {
    return unavailable(
      "proxy-denied",
      "The restricted speech transport is unavailable while a managed proxy is configured.",
    );
  }
  if (config.tools?.media?.audio?.enabled === false) {
    return unavailable("audio-disabled", "Media audio transcription is disabled.");
  }
  if (
    config.tools?.media?.models?.some((entry) => !resolveConfiguredMediaEntryCapabilities(entry))
  ) {
    return unavailable(
      "adapter-unavailable",
      "Declare shared media model capabilities explicitly before restricted dictation. An unknown capability cannot be skipped to select another provider.",
    );
  }
  // Explicit capability tags avoid loading plugins merely to discover whether
  // they might support audio. Ordering/preferredModel remains media-owned.
  const entries = resolveModelEntries({
    cfg: config,
    capability: "audio",
    config: config.tools?.media?.audio,
    providerRegistry: new Map(),
  });
  const selected = entries[0];
  if (!selected) {
    return unavailable(
      "model-missing",
      "Configure a speech model with the audio capability and provision it at the approved endpoint before recording.",
    );
  }
  const { entry } = selected;
  // This invokes the existing host-owned OpenAI-compatible multipart adapter,
  // never a plugin selected by its label. Opaque/CLI adapters are not admitted.
  if (entry.type === "cli" || entry.command || entry.provider !== "openai" || !entry.model) {
    return unavailable(
      "adapter-unavailable",
      "This adapter has no enforced speech transport. The initial restricted route supports explicitly configured OpenAI-compatible batch audio only.",
    );
  }
  const provider = config.models?.providers?.openai;
  const audio = config.tools?.media?.audio;
  if (
    !resolveEffectivePluginActivationState({
      id: "openai",
      origin: "bundled",
      rootConfig: config,
      enabledByDefault: true,
    }).enabled
  ) {
    return unavailable(
      "adapter-disabled",
      "The selected speech adapter is disabled by plugin policy. Review its existing configuration before recording.",
    );
  }
  if (
    provider?.auth !== "none" ||
    entry.profile ||
    entry.preferredProfile ||
    provider.localService ||
    [
      provider.headers,
      audio?.headers,
      entry.headers,
      provider.request,
      audio?.request,
      entry.request,
      provider.params,
      audio?.providerOptions,
      entry.providerOptions,
    ].some((value) => value !== undefined && Object.keys(value).length > 0)
  ) {
    return unavailable(
      "transport-unavailable",
      "This restricted adapter requires explicit no-auth configuration without custom headers, request overrides, credential profiles, or automatic local-service setup.",
    );
  }
  const { baseUrl } = resolveProviderRequestContext({
    cfg: config,
    entry,
    config: audio,
    providerId: "openai",
  });
  try {
    const route = resolveRestrictedAudioRoute({ baseUrl: baseUrl ?? "", model: entry.model });
    const approved = resolveRestrictedAudioRoute({ baseUrl: policy.endpoint, model: entry.model });
    if (route.baseUrl !== approved.baseUrl) {
      return unavailable(
        "destination-denied",
        "The effective speech endpoint differs from the explicitly approved destination. Review settings before recording.",
      );
    }
    const options = resolveEntryRunOptions({
      cfg: config,
      capability: "audio",
      entry,
      config: audio,
    });
    return {
      route,
      readiness: {
        ...readiness,
        configured: true,
        permitted: true,
        provider: "openai",
        model: route.model,
        destination: route.destination,
        reason: "unverified",
        message:
          "The endpoint has not yet been checked. Model listing does not verify recognition or device locality.",
      },
      maxBytes: Math.min(options.maxBytes, MAX_RESTRICTED_WAV_BYTES),
      timeoutMs: Math.min(options.timeoutMs, 120_000),
      language: entry.language ?? audio?.language,
      prompt: options.hasConfiguredPrompt ? options.prompt : undefined,
    };
  } catch (error) {
    return unavailable(
      error instanceof RestrictedAudioError ? error.code : "route-denied",
      error instanceof RestrictedAudioError ? error.message : "The speech endpoint is unavailable.",
    );
  }
}

function speechPolicyRevision(config: OpenClawConfig): string {
  if (!isTalkSpeechDataRestricted(config)) {
    return "external";
  }
  // The hash stays private. No endpoint credentials, hints or configuration are
  // copied into errors/catalogs. These are the actual inputs that can alter the
  // pinned route, payload, permission, resource budget or adapter selection.
  return sha256Hex(
    JSON.stringify({
      policy: config.talk?.speechDataPolicy,
      media: config.tools?.media,
      provider: config.models?.providers?.openai,
      voiceModel: config.agents?.defaults?.voiceModel,
      voiceCall: config.plugins?.entries?.["voice-call"],
      plugins: config.plugins,
      proxy: config.proxy,
    }),
  );
}

/** A new setting can revoke a capture; it can never reroute its accepted audio. */
export function captureTalkSpeechDataAuthority(
  config: OpenClawConfig,
  getCurrentConfig: () => OpenClawConfig,
): () => void {
  const revision = speechPolicyRevision(config);
  return () => {
    if (speechPolicyRevision(getCurrentConfig()) !== revision) {
      throw new RestrictedAudioError("policy-revoked");
    }
  };
}

export function assertTalkConversationSpeechAllowed(config: OpenClawConfig): void {
  if (isTalkSpeechDataRestricted(config)) {
    throw new Error(
      "The selected speech policy permits raw composer dictation only. Conversational Talk and automatic refinement are unavailable.",
    );
  }
}
