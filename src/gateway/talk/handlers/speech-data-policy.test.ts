import { createServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { createPluginMetadataSnapshotFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../../plugins/runtime/generation-scope.js";
import type { RealtimeTranscriptionProviderPlugin } from "../../../plugins/types.js";
import { reserveTestPortListener } from "../../../test-utils/port-claims.js";
import { cleanupTalkConnection } from "../session-registry.js";
import { createTalkHandlerCaller } from "./handler-invocation.test-support.js";
import { talkHandlers } from "./index.js";
import { expectRespondError, expectRespondOk } from "./responses.test-support.js";

function configured(endpoint = "http://127.0.0.1:8080/v1"): OpenClawConfig {
  return {
    agents: { entries: { main: {} } },
    talk: { speechDataPolicy: { mode: "trusted-endpoint", endpoint } },
    models: {
      providers: {
        openai: { baseUrl: endpoint, models: [], auth: "none", apiKey: "synthetic-cloud-key" },
      },
    },
    tools: {
      media: { models: [{ provider: "openai", model: "fixture-stt", capabilities: ["audio"] }] },
    },
  };
}

function withProviders<T>(
  run: () => T,
  createSession: RealtimeTranscriptionProviderPlugin["createSession"] = () => {
    throw new Error("Forbidden cloud fallback reached its transport");
  },
): T {
  const registry = createEmptyPluginRegistry();
  registry.realtimeTranscriptionProviders.push({
    pluginId: "fixture-cloud",
    source: "test",
    provider: {
      id: "fixture-cloud",
      label: "Fixture cloud",
      isConfigured: () => true,
      createSession,
    },
  });
  return withPluginRuntimeGenerationScope(
    {
      pluginRegistry: registry,
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture-cloud",
            contracts: { realtimeTranscriptionProviders: ["fixture-cloud"] },
          },
        ],
      }),
    },
    run,
  );
}

function rpc(getRuntimeConfig: () => OpenClawConfig) {
  const events: Array<{ type?: string; text?: string; message?: string }> = [];
  const context = {
    getRuntimeConfig,
    broadcastToConnIds: (_event: string, payload: (typeof events)[number]) => events.push(payload),
    logGateway: { warn: vi.fn() },
  };
  const invoke = createTalkHandlerCaller(talkHandlers);
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const respond = vi.fn();
    await invoke(method, { params, context, respond });
    return respond;
  };
  return { call, events };
}

afterEach(() => {
  cleanupTalkConnection("conn-1", { warn: vi.fn() });
  clearRuntimeConfigSnapshot();
});

describe("restricted speech through catalog and session RPCs", () => {
  it.each([
    { kind: "device-local", reason: "device-unverified", message: /microphone device/ },
    { kind: "provider", reason: "override-denied", message: /Request overrides/ },
    { kind: "model", reason: "override-denied", message: /Request overrides/ },
    {
      kind: "unknown adapter",
      reason: "adapter-unavailable",
      message: /no enforced speech transport/,
    },
    { kind: "streaming", reason: "adapter-unavailable", message: /streaming or voice-model/ },
  ])(
    "denies $kind consistently before any provider dispatch",
    async ({ kind, reason, message }) => {
      await withProviders(async () => {
        const config = configured();
        if (kind === "device-local") {
          config.talk = { speechDataPolicy: { mode: "device-local" } };
        } else if (kind === "unknown adapter") {
          config.tools!.media!.models!.unshift({
            provider: "opaque-plugin",
            model: "opaque",
            capabilities: ["audio"],
          });
        } else if (kind === "streaming") {
          config.agents!.defaults = { voiceModel: { primary: "cloud/voice" } };
        }
        const { call, events } = rpc(() => config);
        const catalogOverride =
          kind === "provider"
            ? { transcriptionProvider: "openai" }
            : kind === "model"
              ? { transcriptionModel: "fixture-stt" }
              : {};
        const sessionOverride =
          kind === "provider"
            ? { provider: "openai" }
            : kind === "model"
              ? { model: "fixture-stt" }
              : {};
        expect(expectRespondOk(await call("talk.catalog", catalogOverride))).toMatchObject({
          transcription: { ready: false, dataPolicy: { permitted: false, reason } },
        });
        expectRespondError(
          await call("talk.session.create", {
            mode: "transcription",
            purpose: "dictation",
            ...sessionOverride,
          }),
          {
            code: "UNAVAILABLE",
            message: expect.stringMatching(message),
          },
        );
        expect(events).toEqual([]);
      });
    },
  );

  it("refuses a restricted conversational session without enabling agent refinement", async () => {
    await withProviders(async () => {
      const { call } = rpc(() => configured());
      expectRespondError(await call("talk.session.create", { mode: "transcription" }), {
        message: expect.stringContaining("raw composer dictation only"),
      });
    });
  });

  it("refuses derived text sent to talk.speak under the same restriction", async () => {
    await withProviders(async () => {
      const { call } = rpc(() => configured());
      const result = await call("talk.speak", { text: "private synthetic transcript" });
      expectRespondError(result, {
        message: expect.stringContaining("raw composer dictation only"),
      });
      expect(JSON.stringify(result.mock.calls)).not.toContain("private synthetic transcript");
    });
  });

  it("closes an existing external session when a restriction is published", async () => {
    let closes = 0;
    let writes = 0;
    let cfg: OpenClawConfig = {
      ...configured(),
      talk: { speechDataPolicy: { mode: "external" } },
      plugins: {
        entries: { "voice-call": { config: { streaming: { provider: "fixture-cloud" } } } },
      },
    };
    await withProviders(
      async () => {
        setRuntimeConfigSnapshot(cfg);
        const { call, events } = rpc(() => cfg);
        const { sessionId } = expectRespondOk(
          await call("talk.session.create", { mode: "transcription", purpose: "dictation" }),
        );
        expectRespondOk(await call("talk.session.appendAudio", { sessionId, audioBase64: "/w==" }));
        expect(writes).toBe(1);
        cfg = { ...cfg, talk: { speechDataPolicy: { mode: "device-local" } } };
        setRuntimeConfigSnapshot(cfg);
        expect(closes).toBe(1);
        expect(events).toContainEqual(expect.objectContaining({ type: "close" }));
        expectRespondError(
          await call("talk.session.appendAudio", { sessionId, audioBase64: "/w==" }),
          { code: "UNAVAILABLE" },
        );
        expect(writes).toBe(1);
      },
      () => ({
        connect: async () => {},
        isConnected: () => true,
        sendAudio: () => {
          writes += 1;
        },
        close: () => {
          closes += 1;
        },
      }),
    );
  });
});

// Preserve host network controls; this is synthetic socket/dispatch proof, not inference.
const proxyConfigured =
  process.env.OPENCLAW_PROXY_ACTIVE === "1" ||
  [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "OPENCLAW_PROXY_URL",
  ].some((key) => Boolean(process.env[key]?.trim()));

describe.skipIf(proxyConfigured)("restricted Talk RPC loopback transport", () => {
  let fixture: Awaited<ReturnType<typeof reserveTestPortListener<ReturnType<typeof createServer>>>>;
  const requests: { path?: string; method?: string; auth?: string; body: Buffer }[] = [];
  let advertised = true;
  let holdResponse = false;
  let uploading = createDeferred();
  let disconnected = createDeferred();
  const endpoint = () => `http://127.0.0.1:${fixture.claim.port}/v1`;
  beforeAll(async () => {
    fixture = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            requests.push({
              path: req.url,
              method: req.method,
              auth: req.headers.authorization,
              body: Buffer.concat(chunks),
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            if (holdResponse && req.url?.endsWith("/audio/transcriptions")) {
              res.once("close", () => disconnected.resolve());
              res.write('{"text":"');
              uploading.resolve();
              return;
            }
            res.end(
              JSON.stringify(
                req.url?.endsWith("/models")
                  ? { data: advertised ? [{ id: "fixture-stt" }] : [] }
                  : { text: "synthetic dictation result" },
              ),
            );
          });
        }),
    });
  });
  beforeEach(() => {
    requests.length = 0;
    advertised = true;
    holdResponse = false;
    uploading = createDeferred();
    disconnected = createDeferred();
  });
  afterAll(async () => {
    fixture.listener.closeAllConnections();
    try {
      await fixture.releaseListener();
    } finally {
      await fixture.claim.release();
    }
  });

  it("matches catalog/session selection and sends one WAV only to the approved route", async () => {
    await withProviders(async () => {
      const cfg = configured(endpoint());
      const { call, events } = rpc(() => cfg);
      expect(expectRespondOk(await call("talk.catalog"))).toMatchObject({
        transcription: {
          ready: true,
          activeProvider: "openai",
          dataPolicy: {
            mode: "trusted-endpoint",
            model: "fixture-stt",
            transport: "batch",
            initialized: false,
            available: true,
            permitted: true,
          },
        },
      });
      const created = expectRespondOk(
        await call("talk.session.create", { mode: "transcription", purpose: "dictation" }),
        {
          provider: "openai",
          mode: "transcription",
          transport: "gateway-relay",
        },
      );
      const sessionId = created.sessionId;
      expect(created.dataPolicy).toMatchObject({
        model: "fixture-stt",
        available: true,
        permitted: true,
      });
      expectRespondOk(
        await call("talk.session.appendAudio", {
          sessionId,
          audioBase64: Buffer.from([0, 0x80, 0xff, 0x10]).toString("base64"),
        }),
      );
      expect(requests.map(({ method }) => method)).toEqual(["GET", "GET"]);
      expectRespondOk(await call("talk.session.close", { sessionId }));
      expect(requests.map(({ method, path }) => [method, path])).toEqual([
        ["GET", "/v1/models"],
        ["GET", "/v1/models"],
        ["POST", "/v1/audio/transcriptions"],
      ]);
      expect(requests.every(({ auth }) => auth === undefined)).toBe(true);
      expect(requests[2]?.body.includes(Buffer.from("RIFF"))).toBe(true);
      expect(events).toContainEqual(
        expect.objectContaining({ type: "transcript", text: "synthetic dictation result" }),
      );
    });
  });

  it("refuses a missing model with cloud credentials present and never uploads or falls back", async () => {
    advertised = false;
    await withProviders(async () => {
      const cfg = configured(endpoint());
      const { call, events } = rpc(() => cfg);
      expect(expectRespondOk(await call("talk.catalog"))).toMatchObject({
        transcription: { ready: false, dataPolicy: { reason: "model-missing", permitted: true } },
      });
      expectRespondError(
        await call("talk.session.create", { mode: "transcription", purpose: "dictation" }),
        {
          message: expect.stringContaining("not advertised"),
        },
      );
      expect(requests.map(({ method, path }) => [method, path])).toEqual([
        ["GET", "/v1/models"],
        ["GET", "/v1/models"],
      ]);
      expect(events).toEqual([]);
    });
  });

  it("revokes a pinned session before additional audio or final dispatch after settings change", async () => {
    await withProviders(async () => {
      const cfg = configured(endpoint());
      const { call, events } = rpc(() => cfg);
      const { sessionId } = expectRespondOk(
        await call("talk.session.create", { mode: "transcription", purpose: "dictation" }),
      );
      expectRespondOk(await call("talk.session.appendAudio", { sessionId, audioBase64: "/w==" }));
      cfg.talk!.speechDataPolicy = { mode: "external" };
      expectRespondError(
        await call("talk.session.appendAudio", { sessionId, audioBase64: "/w==" }),
        {
          message: expect.stringContaining("changed"),
        },
      );
      await call("talk.session.close", { sessionId, discard: true });
      expect(requests.map(({ method, path }) => [method, path])).toEqual([["GET", "/v1/models"]]);
      expect(events.filter(({ text }) => text)).toEqual([]);
    });
  });

  it("aborts an admitted upload when the config owner publishes a revoked policy", async () => {
    await withProviders(async () => {
      const cfg = configured(endpoint());
      setRuntimeConfigSnapshot(cfg);
      const { call, events } = rpc(() => cfg);
      const { sessionId } = expectRespondOk(
        await call("talk.session.create", { mode: "transcription", purpose: "dictation" }),
      );
      expectRespondOk(await call("talk.session.appendAudio", { sessionId, audioBase64: "/w==" }));
      holdResponse = true;
      const closing = call("talk.session.close", { sessionId });
      try {
        await awaitGateBeforeSettlement(
          uploading.promise,
          closing,
          "close settled before the upload",
        );
        cfg.talk!.speechDataPolicy = { mode: "device-local" };
        setRuntimeConfigSnapshot(cfg);
        expect(events).toContainEqual(expect.objectContaining({ type: "close" }));
        await closing;
        await disconnected.promise;
        expect(events.filter(({ text }) => text)).toEqual([]);
        expect(requests.map(({ method, path }) => [method, path])).toEqual([
          ["GET", "/v1/models"],
          ["POST", "/v1/audio/transcriptions"],
        ]);
      } finally {
        cleanupTalkConnection("conn-1", { warn: vi.fn() });
        fixture.listener.closeAllConnections();
        await closing;
      }
    });
  });
});
