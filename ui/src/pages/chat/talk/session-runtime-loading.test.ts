// @vitest-environment node
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import { voiceCaptureLocksFixture } from "./input.test-support.ts";
import { RealtimeTalkSession } from "./session.ts";

type TransportRuntime = typeof import("./transport.runtime.ts");

afterEach(() => {
  vi.doUnmock("./transport.runtime.ts");
  vi.unstubAllGlobals();
});

it.each(["stopped", "failed"] as const)(
  "allocates no microphone or provider for a %s runtime load and releases its admission",
  async (outcome) => {
    const moduleReady = createDeferred<TransportRuntime>();
    const importStarted = createDeferred();
    const firstClose = createDeferred();
    vi.doMock("./transport.runtime.ts", () => {
      importStarted.resolve();
      return moduleReady.promise;
    });
    const getUserMedia = vi.fn(async () => {
      const track = Object.assign(new EventTarget(), { stop: vi.fn() });
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia },
      locks: voiceCaptureLocksFixture(),
    });
    let allocations = 0;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "talk.client.create") {
        return {
          provider: "fixture",
          transport: "webrtc",
          voiceSessionId: `voice-runtime-${++allocations}`,
          clientSecret: "synthetic-session",
        };
      }
      if (method === "talk.client.close") {
        if (asOptionalRecord(params)?.voiceSessionId === "voice-runtime-1") {
          await firstClose.promise;
        }
        return { ok: true };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const createRealtimeTalkTransport = vi.fn<TransportRuntime["createRealtimeTalkTransport"]>(
      (_session, context) => ({
        start: async () => "ready",
        stop: () => context.input.stop(),
      }),
    );
    const runtime = { createRealtimeTalkTransport } satisfies TransportRuntime;
    const client = createTestGatewayClient(request);
    const session = new RealtimeTalkSession(client, "agent:main:runtime-load");
    const sibling = new RealtimeTalkSession(client, "agent:main:runtime-load");
    const starting = session.start();
    void starting.catch(() => undefined);
    try {
      await importStarted.promise;
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(createRealtimeTalkTransport).not.toHaveBeenCalled();

      if (outcome === "stopped") {
        await session.stop();
        moduleReady.resolve(runtime);
        await expect(starting).resolves.toBeUndefined();
      } else {
        const failure = new Error("Synthetic Talk runtime unavailable");
        moduleReady.reject(failure);
        await expect(starting).rejects.toHaveProperty("cause", failure);
        vi.doMock("./transport.runtime.ts", () => runtime);
      }
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(createRealtimeTalkTransport).not.toHaveBeenCalled();
      expect(session.getVoiceSessionId()).toBeUndefined();

      // Both logical call slots remain usable while physical capture stays exclusive.
      // A draining stopped call plus a new capture still exposes a leaked startup slot.
      await session.start();
      expect(session.getVoiceSessionId()).toBe("voice-runtime-1");
      await expect(sibling.start()).rejects.toThrow(/microphone/i);
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(createRealtimeTalkTransport).toHaveBeenCalledOnce();
      const closing = session.stop();
      await sibling.start();
      expect(sibling.getVoiceSessionId()).toBe("voice-runtime-2");
      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(createRealtimeTalkTransport).toHaveBeenCalledTimes(2);
      expect(request.mock.calls.filter(([method]) => method === "talk.client.create")).toHaveLength(
        2,
      );
      firstClose.resolve();
      await closing;
    } finally {
      moduleReady.resolve(runtime);
      firstClose.resolve();
      await starting.catch(() => undefined);
      await Promise.all([session.stop(), sibling.stop()]);
    }
  },
);
