import { createServer, type IncomingMessage } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import {
  probeRestrictedAudioRoute,
  resolveRestrictedAudioRoute,
  transcribeRestrictedAudio,
} from "./restricted-audio.js";

// Preserve ambient host network controls. Run socket evidence only on an unproxied worker.
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
const wav = Buffer.from(
  "524946462c00000057415645666d74201000000001000100401f0000803e000002001000646174610800000000001000f0ff0000",
  "hex",
);

describe.skipIf(proxyConfigured)(
  "restricted speech actual loopback transport (synthetic, not inference)",
  () => {
    let fixture: Awaited<
      ReturnType<typeof reserveTestPortListener<ReturnType<typeof createServer>>>
    >;
    const observed: {
      url: string | undefined;
      method: string | undefined;
      headers: IncomingMessage["headers"];
      body: Buffer;
    }[] = [];
    let stalled = createDeferred();
    let disconnected = createDeferred();
    const request = (prefix = "/v1") => ({
      route: resolveRestrictedAudioRoute({
        baseUrl: `http://127.0.0.1:${fixture.claim.port}${prefix}`,
        model: "fixture-stt",
      }),
      assertCurrent: () => {},
    });

    beforeAll(async () => {
      fixture = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => {
              observed.push({
                url: req.url,
                method: req.method,
                headers: req.headers,
                body: Buffer.concat(chunks),
              });
              if (req.url === "/redirect/audio/transcriptions") {
                res.writeHead(307, { location: "/escape" });
                res.end();
                return;
              }
              if (req.url === "/stall/audio/transcriptions") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.write('{"text":"');
                res.once("close", () => disconnected.resolve());
                stalled.resolve();
                return;
              }
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify(
                  req.url?.endsWith("/models")
                    ? { data: [{ id: "fixture-stt" }] }
                    : { text: "fixture reply" },
                ),
              );
            });
          }),
      });
    });
    beforeEach(() => {
      observed.length = 0;
      stalled = createDeferred();
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

    it("observes a content-free readiness GET and exactly one approved multipart POST", async () => {
      expect(await probeRestrictedAudioRoute(request())).toMatchObject({
        available: true,
        initialized: false,
        permitted: true,
      });
      expect(await transcribeRestrictedAudio({ ...request(), buffer: wav })).toEqual({
        text: "fixture reply",
        model: "fixture-stt",
      });
      expect(observed.map(({ method, url }) => [method, url])).toEqual([
        ["GET", "/v1/models"],
        ["POST", "/v1/audio/transcriptions"],
      ]);
      expect(observed[0]?.body.length).toBe(0);
      expect(observed[1]?.body.includes(wav)).toBe(true);
      expect(observed[1]?.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
      expect(observed[1]?.headers.authorization).toBeUndefined();
      expect(observed[1]?.headers.cookie).toBeUndefined();
    });

    it("never opens a redirect destination or replays audio", async () => {
      await expect(
        transcribeRestrictedAudio({ ...request("/redirect"), buffer: wav }),
      ).rejects.toMatchObject({ code: "route-denied" });
      expect(observed.map(({ url }) => url)).toEqual(["/redirect/audio/transcriptions"]);
    });

    it("closes the cancelled request while an independent request remains usable", async () => {
      const controller = new AbortController();
      const pending = transcribeRestrictedAudio({
        ...request("/stall"),
        buffer: wav,
        signal: controller.signal,
      });
      const checked = expect(pending).rejects.toMatchObject({ code: "cancelled" });
      await stalled.promise;
      controller.abort();
      await checked;
      await disconnected.promise;
      expect(await transcribeRestrictedAudio({ ...request(), buffer: wav })).toMatchObject({
        text: "fixture reply",
      });
      expect(observed).toHaveLength(2);
    });
  },
);
