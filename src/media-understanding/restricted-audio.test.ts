import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  probeRestrictedAudioRoute,
  resolveRestrictedAudioRoute,
  transcribeRestrictedAudio,
} from "./restricted-audio.js";

const { runtimeFetch } = vi.hoisted(() => ({ runtimeFetch: vi.fn<typeof fetch>() }));
// Keep the actual guarded fetch, response reader, and multipart adapter. Only the socket is modeled.
vi.mock("../infra/net/runtime-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/net/runtime-fetch.js")>()),
  fetchWithRuntimeDispatcher: runtimeFetch,
}));

const proxyKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_URL",
];
const route = resolveRestrictedAudioRoute({
  baseUrl: "http://127.0.0.1:8080/v1/",
  model: "fixture-stt",
});
// Four synthetic PCM samples; this tests transport, never recognition quality or model inference.
const wav = Buffer.from(
  "524946462c00000057415645666d74201000000001000100401f0000803e000002001000646174610800000000001000f0ff0000",
  "hex",
);
const request = { route, assertCurrent: () => {} };
const transcribe = (overrides: Partial<Parameters<typeof transcribeRestrictedAudio>[0]> = {}) =>
  transcribeRestrictedAudio({ ...request, buffer: wav, ...overrides });

beforeEach(() => {
  // These variables belong to the modeled transport only; this file cannot open a socket.
  for (const key of proxyKeys) {
    vi.stubEnv(key, undefined);
  }
  runtimeFetch
    .mockReset()
    .mockResolvedValue(new Response(JSON.stringify({ text: "fixture text" })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("restricted speech admission", () => {
  it("freezes a canonical destination without claiming capture-device locality", () => {
    expect(route).toMatchObject({
      baseUrl: "http://127.0.0.1:8080/v1",
      destination: "http://127.0.0.1:8080",
      model: "fixture-stt",
    });
    expect(Object.isFrozen(route)).toBe(true);
    expect(
      resolveRestrictedAudioRoute({ baseUrl: "https://[::1]/v1", model: "fixture" }).hostname,
    ).toBe("::1");
  });

  it.each([
    "https://speech.example/v1",
    "http://192.168.1.2/v1",
    "http://127.1/v1",
    "http://2130706433/v1",
    "http://127.0.0.1./v1",
    "http://u:p@127.0.0.1/v1",
    "http://127.0.0.1/v1?key=x",
    "http://127.0.0.1/v1#fragment",
    " http://127.0.0.1/v1",
    "file:///speech",
  ])("rejects unsupported endpoint %s before dispatch", (baseUrl) => {
    expect(() => resolveRestrictedAudioRoute({ baseUrl, model: "fixture" })).toThrow(
      expect.objectContaining({ code: "route-denied" }),
    );
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it("revalidates copied route objects at the actual delivery boundary", async () => {
    await expect(
      transcribe({ route: { ...route, baseUrl: "https://speech.example/v1" } }),
    ).rejects.toMatchObject({ code: "route-denied" });
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it.each(proxyKeys)("refuses %s even for an approved loopback and NO_PROXY", async (key) => {
    vi.stubEnv(key, key === "OPENCLAW_PROXY_ACTIVE" ? "1" : "http://proxy.invalid:3128");
    vi.stubEnv("NO_PROXY", "*");
    expect(await probeRestrictedAudioRoute(request)).toMatchObject({
      available: false,
      permitted: false,
      error: { code: "proxy-denied" },
    });
    await expect(transcribe()).rejects.toMatchObject({ code: "proxy-denied" });
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "revokes at final synchronous admission (async=%s)",
    async (asynchronous) => {
      let checks = 0;
      const assertCurrent = () => {
        if (++checks > 1) {
          if (asynchronous) {
            return Promise.resolve();
          }
          throw new Error("private stale route detail");
        }
      };
      // oxlint-disable-next-line typescript/no-misused-promises -- The asynchronous callback deliberately violates final synchronous admission.
      await expect(transcribe({ assertCurrent })).rejects.toMatchObject({ code: "policy-revoked" });
      expect(runtimeFetch).not.toHaveBeenCalled();
    },
  );

  it("denies an ambient proxy introduced during preparation", async () => {
    let checks = 0;
    const assertCurrent = () => {
      if (++checks === 2) {
        vi.stubEnv("HTTPS_PROXY", "http://proxy.invalid");
      }
    };
    await expect(transcribe({ assertCurrent })).rejects.toMatchObject({ code: "proxy-denied" });
    expect(runtimeFetch).not.toHaveBeenCalled();
  });
});

describe("restricted speech HTTP contract", () => {
  it("probes model presence with a GET and distinguishes availability from initialization", async () => {
    runtimeFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: route.model }] })),
    );
    expect(await probeRestrictedAudioRoute(request)).toEqual({
      configured: true,
      initialized: false,
      available: true,
      permitted: true,
    });
    const [url, init] = runtimeFetch.mock.calls[0]!;
    expect(url).toBe(`${route.baseUrl}/models`);
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(init?.body).toBeUndefined();
    expect([...new Headers(init?.headers)]).toEqual([]);
  });

  it("reports a missing model as unavailable while retaining permission", async () => {
    runtimeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "other" }] })));
    expect(await probeRestrictedAudioRoute(request)).toMatchObject({
      configured: true,
      initialized: false,
      available: false,
      permitted: true,
      error: { code: "model-missing" },
    });
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
  });

  it("uses the existing no-auth multipart shape and one selected model", async () => {
    expect(await transcribe({ language: "en", prompt: "fixture hint" })).toEqual({
      text: "fixture text",
      model: route.model,
    });
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = runtimeFetch.mock.calls[0]!;
    expect(url).toBe(`${route.baseUrl}/audio/transcriptions`);
    expect([...new Headers(init?.headers)]).toEqual([]);
    const form = init?.body as FormData;
    expect([...form.keys()]).toEqual(["model", "language", "prompt", "file"]);
    expect(form.get("model")).toBe(route.model);
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBe("fixture hint");
    const file = form.get("file") as File;
    expect(file.name).toBe("speech.wav");
    expect(file.type).toBe("audio/wav");
    expect(Buffer.from(await file.arrayBuffer())).toEqual(wav);
  });

  it.each(["/other", "https://192.0.2.1/collect"])(
    "rejects redirect %s without replay",
    async (location) => {
      runtimeFetch.mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { location } }),
      );
      await expect(transcribe()).rejects.toMatchObject({ code: "route-denied" });
      expect(runtimeFetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [401, "credentials-required"],
    [415, "format-mismatch"],
    [500, "endpoint-failed"],
  ])("redacts status %i without retaining an error body or cause", async (status, code) => {
    const secret = "private dictated words and endpoint credential";
    runtimeFetch.mockResolvedValueOnce(new Response(secret, { status: Number(status) }));
    const failure = await transcribe().catch((error: unknown) => error);
    expect(failure).toMatchObject({ code });
    expect(String(failure)).not.toContain(secret);
    expect(failure).not.toHaveProperty("cause");
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
  });

  it.each(["private malformed response", JSON.stringify({ text: 12 })])(
    "rejects an invalid response with a fixed error",
    async (body) => {
      runtimeFetch.mockResolvedValueOnce(new Response(body));
      await expect(transcribe()).rejects.toMatchObject({ code: "invalid-response" });
    },
  );

  it("preserves an empty silence result without fallback", async () => {
    runtimeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ text: " " })));
    expect(await transcribe()).toEqual({ text: "", model: route.model });
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
  });

  it("caps response bytes and audio size before retaining a transcript", async () => {
    runtimeFetch.mockResolvedValueOnce(new Response(JSON.stringify({ text: "x".repeat(65536) })));
    await expect(transcribe()).rejects.toMatchObject({ code: "resource-limit" });
    runtimeFetch.mockClear();
    const oversized = Buffer.alloc(44 + 8000 * 2 * 121);
    wav.copy(oversized);
    oversized.writeUInt32LE(oversized.length - 8, 4);
    oversized.writeUInt32LE(oversized.length - 44, 40);
    await expect(transcribe({ buffer: oversized })).rejects.toMatchObject({
      code: "resource-limit",
    });
    await expect(transcribe({ buffer: Buffer.from("unsupported audio") })).rejects.toMatchObject({
      code: "format-mismatch",
    });
    expect(runtimeFetch).not.toHaveBeenCalled();
  });
});

describe("restricted speech lifecycle", () => {
  it("does not dispatch after cancellation", async () => {
    await expect(transcribe({ signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(runtimeFetch).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "policy-revoked"])(
    "suppresses a late result after %s without replay",
    async (code) => {
      const entered = createDeferred();
      const response = createDeferred<Response>();
      const controller = new AbortController();
      let permitted = true;
      runtimeFetch.mockImplementationOnce(async () => {
        entered.resolve();
        return response.promise;
      });
      const pending = transcribe({
        signal: controller.signal,
        assertCurrent: () => {
          if (!permitted) {
            throw new Error("private settings change");
          }
        },
      });
      const checked = expect(pending).rejects.toMatchObject({ code });
      await entered.promise;
      if (code === "cancelled") {
        controller.abort();
      } else {
        permitted = false;
      }
      response.resolve(new Response(JSON.stringify({ text: "late private transcript" })));
      await checked;
      expect(runtimeFetch).toHaveBeenCalledTimes(1);
      expect(await transcribe()).toEqual({ text: "fixture text", model: route.model });
    },
  );

  it.each(["probe", "transcription", "body"])(
    "bounds a stalled %s response and cancels its owned body",
    async (kind) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      runtimeFetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
      const checked =
        kind === "probe"
          ? expect(probeRestrictedAudioRoute(request)).resolves.toMatchObject({
              available: false,
              permitted: true,
              error: { code: "probe-timeout" },
            })
          : expect(transcribe({ timeoutMs: kind === "body" ? 60_000 : 50 })).rejects.toMatchObject({
              code: "transcription-timeout",
            });
      await vi.advanceTimersByTimeAsync(kind === "probe" ? 2000 : kind === "body" ? 15_000 : 50);
      await checked;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(runtimeFetch).toHaveBeenCalledTimes(1);
    },
  );
});
