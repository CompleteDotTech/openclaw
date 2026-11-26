import { isIP } from "node:net";
import { isLoopbackIpAddress } from "@openclaw/net-policy/ip";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import type { AudioTranscriptionResult } from "../../packages/media-understanding-common/src/types.js";
import { readProviderJsonObjectResponse } from "../agents/provider-http-errors.js";
import { fetchWithSsrFGuard, GuardedFetchRedirectError } from "../infra/net/fetch-guard.js";
import { normalizeHostname } from "../infra/net/hostname.js";
import { fetchWithRuntimeDispatcher } from "../infra/net/runtime-fetch.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { transcribeOpenAiCompatibleAudio } from "./openai-compatible-audio.js";

const PROBE_TIMEOUT_MS = 2_000;
const TRANSCRIPTION_TIMEOUT_MS = 60_000;
const MAX_TRANSCRIPTION_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_HINT_BYTES = 16 * 1024;
const MAX_AUDIO_SECONDS = 120;

const FAILURE_MESSAGES = {
  "route-denied":
    "This speech route requires an approved literal IP endpoint without URL credentials, query, or fragment. HTTP is supported only on loopback.",
  "proxy-denied":
    "Restricted speech is unavailable while an outbound or managed proxy is configured.",
  "policy-revoked":
    "Speech permission or the selected route changed. Start a new recording after reviewing the destination.",
  "model-missing":
    "The selected speech model is not advertised by the endpoint. Provision it explicitly before recording.",
  "endpoint-unreachable":
    "The approved speech endpoint could not be reached. Check it and start a new recording; audio is not retried automatically.",
  "endpoint-failed":
    "The approved speech endpoint rejected the request. Check the endpoint and start a new recording.",
  "credentials-required":
    "The approved endpoint requires credentials. This restricted adapter currently supports no-auth endpoints only.",
  "format-mismatch": "Restricted transcription requires mono 8 kHz or 16 kHz PCM16 WAV audio.",
  "resource-limit": "The speech request or endpoint response exceeds the supported resource limit.",
  "probe-timeout":
    "The speech readiness probe timed out. Check the endpoint and retry readiness explicitly.",
  "transcription-timeout":
    "Speech recognition timed out. Start a new recording when the endpoint is ready; audio is not replayed.",
  "invalid-response": "The approved speech endpoint returned an unsupported response.",
  cancelled: "Speech processing was cancelled. Start a new recording to try again.",
} as const;

export type RestrictedAudioFailureCode = keyof typeof FAILURE_MESSAGES;

export class RestrictedAudioError extends Error {
  constructor(readonly code: RestrictedAudioFailureCode) {
    super(FAILURE_MESSAGES[code]);
    this.name = "RestrictedAudioError";
  }
}

export type RestrictedAudioRoute = Readonly<{
  baseUrl: string;
  model: string;
  /** This is the Gateway's destination, not proof of microphone-device locality. */
  destination: string;
  hostname: string;
}>;

export type RestrictedAudioReadiness = {
  configured: true;
  /** A content-free model-list probe does not establish model initialization or inference. */
  initialized: false;
  available: boolean;
  permitted: boolean;
  error?: { code: RestrictedAudioFailureCode; message: string };
};

type RestrictedAudioRequest = {
  route: RestrictedAudioRoute;
  signal?: AbortSignal;
  assertCurrent: () => void;
};

/** Resolve only the small, named no-auth HTTP contract; no provider hooks or setup run here. */
export function resolveRestrictedAudioRoute(params: {
  baseUrl: string;
  model: string;
}): RestrictedAudioRoute {
  const url = URL.parse(params.baseUrl);
  // Validate the authored host as well as URL's canonical form: URL accepts legacy IPv4 spellings.
  const authoredHost = params.baseUrl.match(
    /^https?:\/\/(\[[^\]]+\]|[^:/?#@]+)(?::\d+)?(?:\/|$)/i,
  )?.[1];
  const hostname = url ? normalizeHostname(url.hostname) : "";
  if (
    !url ||
    params.baseUrl.length > 2048 ||
    params.baseUrl !== params.baseUrl.trim() ||
    /[\u0000-\u0020\u007f\\]/u.test(params.baseUrl) ||
    !authoredHost ||
    isIP(authoredHost.replace(/^\[|\]$/g, "")) === 0 ||
    isIP(hostname) === 0 ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    params.baseUrl.includes("?") ||
    params.baseUrl.includes("#") ||
    (url.protocol === "http:" && !isLoopbackIpAddress(hostname))
  ) {
    throw new RestrictedAudioError("route-denied");
  }
  const model = params.model.trim();
  if (!model || Buffer.byteLength(model) > 256 || /\p{Cc}/u.test(model)) {
    throw new RestrictedAudioError("model-missing");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  const baseUrl = url.href.replace(/\/$/, "");
  return Object.freeze({ baseUrl, model, destination: url.origin, hostname });
}

function assertNoProxy(): void {
  if (
    [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "OPENCLAW_PROXY_URL",
    ].some((key) => Boolean(process.env[key]?.trim())) ||
    process.env.OPENCLAW_PROXY_ACTIVE === "1"
  ) {
    throw new RestrictedAudioError("proxy-denied");
  }
}

async function withRestrictedRequest<T>(
  params: RestrictedAudioRequest,
  timeoutMs: number,
  timeoutCode: "probe-timeout" | "transcription-timeout",
  run: (signal: AbortSignal, assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, deadline.signal])
    : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), timeoutMs).unref();
  const assertTransportPermitted = () => {
    if (signal.aborted) {
      throw new RestrictedAudioError(params.signal?.aborted ? "cancelled" : timeoutCode);
    }
    assertNoProxy();
  };
  const assertCurrent = () => {
    assertTransportPermitted();
    try {
      const result: unknown = params.assertCurrent();
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new RestrictedAudioError("policy-revoked");
      }
    } catch {
      throw new RestrictedAudioError("policy-revoked");
    }
    assertTransportPermitted();
  };
  try {
    assertCurrent();
    const result = await run(signal, assertCurrent);
    // Cancellation/revocation after headers must also suppress late private output.
    assertCurrent();
    return result;
  } catch (error) {
    if (params.signal?.aborted) {
      throw new RestrictedAudioError("cancelled");
    }
    if (deadline.signal.aborted) {
      throw new RestrictedAudioError(timeoutCode);
    }
    if (error instanceof RestrictedAudioError) {
      throw error;
    }
    if (error instanceof SsrFBlockedError || error instanceof GuardedFetchRedirectError) {
      throw new RestrictedAudioError("route-denied");
    }
    // Do not retain provider bodies, URL-bearing error messages, credentials, or causes.
    throw new RestrictedAudioError("endpoint-unreachable");
  } finally {
    clearTimeout(timer);
  }
}

function fetchRestricted(
  route: RestrictedAudioRoute,
  path: "/models" | "/audio/transcriptions",
  init: RequestInit,
  signal: AbortSignal,
  assertCurrent: () => void,
) {
  return fetchWithSsrFGuard({
    url: `${route.baseUrl}${path}`,
    init,
    signal,
    beforeRequest: assertCurrent,
    fetchImpl: fetchWithRuntimeDispatcher,
    mode: "strict",
    pinDns: true,
    dispatcherPolicy: { mode: "direct" },
    policy: { allowedOrigins: [route.destination], hostnameAllowlist: [route.hostname] },
    maxRedirects: 0,
    capture: false,
    auditContext: "restricted-speech",
  });
}

async function readRestrictedResponse(
  response: Response,
  signal: AbortSignal,
  timeoutCode: "probe-timeout" | "transcription-timeout",
) {
  if (!response.ok) {
    throw new RestrictedAudioError(
      response.status === 401 || response.status === 403
        ? "credentials-required"
        : response.status === 415
          ? "format-mismatch"
          : "endpoint-failed",
    );
  }
  try {
    return await readProviderJsonObjectResponse(response, "Speech endpoint", {
      signal,
      timeoutMs: READ_TIMEOUT_MS,
      chunkTimeoutMs: READ_TIMEOUT_MS,
      onTimeout: () => new RestrictedAudioError(timeoutCode),
      onIdleTimeout: () => new RestrictedAudioError(timeoutCode),
      maxBytes: MAX_RESPONSE_BYTES,
      requestHeaders: new Headers(),
      onOverflow: () => new RestrictedAudioError("resource-limit"),
    });
  } catch (error) {
    throw error instanceof RestrictedAudioError
      ? error
      : new RestrictedAudioError("invalid-response");
  }
}

/** One content-free probe. Model presence does not prove recognition, accuracy, or locality. */
export async function probeRestrictedAudioRoute(
  params: RestrictedAudioRequest,
): Promise<RestrictedAudioReadiness> {
  try {
    // Revalidate at the transport boundary and retain only an immutable primitive snapshot.
    const route = resolveRestrictedAudioRoute(params.route);
    await withRestrictedRequest(
      params,
      PROBE_TIMEOUT_MS,
      "probe-timeout",
      async (signal, guard) => {
        const { response, release } = await fetchRestricted(
          route,
          "/models",
          { method: "GET" },
          signal,
          guard,
        );
        try {
          const payload = await readRestrictedResponse(response, signal, "probe-timeout");
          if (!Array.isArray(payload.data)) {
            throw new RestrictedAudioError("invalid-response");
          }
          if (
            !payload.data.some(
              (entry: unknown) =>
                typeof entry === "object" &&
                entry !== null &&
                "id" in entry &&
                entry.id === route.model,
            )
          ) {
            throw new RestrictedAudioError("model-missing");
          }
        } finally {
          await release();
        }
      },
    );
    return { configured: true, initialized: false, available: true, permitted: true };
  } catch (error) {
    const failure =
      error instanceof RestrictedAudioError
        ? error
        : new RestrictedAudioError("endpoint-unreachable");
    return {
      configured: true,
      initialized: false,
      available: false,
      permitted: !["route-denied", "proxy-denied", "policy-revoked", "cancelled"].includes(
        failure.code,
      ),
      error: { code: failure.code, message: failure.message },
    };
  }
}

function assertPcmWav(buffer: Buffer): void {
  if (
    buffer.length < 46 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 16) !== "WAVEfmt " ||
    buffer.toString("ascii", 36, 40) !== "data" ||
    buffer.readUInt32LE(4) !== buffer.length - 8 ||
    buffer.readUInt32LE(16) !== 16 ||
    buffer.readUInt16LE(20) !== 1 ||
    buffer.readUInt16LE(22) !== 1 ||
    ![8000, 16000].includes(buffer.readUInt32LE(24)) ||
    buffer.readUInt32LE(28) !== buffer.readUInt32LE(24) * 2 ||
    buffer.readUInt16LE(32) !== 2 ||
    buffer.readUInt16LE(34) !== 16 ||
    buffer.readUInt32LE(40) !== buffer.length - 44 ||
    (buffer.length - 44) % 2 !== 0
  ) {
    throw new RestrictedAudioError("format-mismatch");
  }
  if (buffer.length - 44 > buffer.readUInt32LE(24) * 2 * MAX_AUDIO_SECONDS) {
    throw new RestrictedAudioError("resource-limit");
  }
}

/** One no-auth request through the existing multipart adapter; never download, retry, or fall back. */
export async function transcribeRestrictedAudio(
  params: RestrictedAudioRequest & {
    buffer: Buffer;
    language?: string;
    prompt?: string;
    timeoutMs?: number;
  },
): Promise<AudioTranscriptionResult> {
  const route = resolveRestrictedAudioRoute(params.route);
  assertPcmWav(params.buffer);
  if (
    Buffer.byteLength(params.prompt ?? "") > MAX_HINT_BYTES ||
    Buffer.byteLength(params.language ?? "") > 64
  ) {
    throw new RestrictedAudioError("resource-limit");
  }
  const requestedTimeoutMs = params.timeoutMs ?? TRANSCRIPTION_TIMEOUT_MS;
  const timeoutMs =
    Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? Math.min(requestedTimeoutMs, MAX_TRANSCRIPTION_TIMEOUT_MS)
      : TRANSCRIPTION_TIMEOUT_MS;
  return withRestrictedRequest(params, timeoutMs, "transcription-timeout", async (signal, guard) =>
    transcribeOpenAiCompatibleAudio(
      {
        buffer: params.buffer,
        fileName: "speech.wav",
        mime: "audio/wav",
        model: route.model,
        defaultModel: route.model,
        baseUrl: route.baseUrl,
        defaultBaseUrl: route.baseUrl,
        apiKey: "",
        auth: { kind: "none", source: "approved-no-auth-speech-endpoint" },
        signal,
        language: params.language,
        prompt: params.prompt,
        timeoutMs,
      },
      {
        baseUrl: route.baseUrl,
        post: async (request) => {
          if (
            request.url !== `${route.baseUrl}/audio/transcriptions` ||
            [...request.headers].length > 0
          ) {
            throw new RestrictedAudioError("route-denied");
          }
          return fetchRestricted(
            route,
            "/audio/transcriptions",
            { method: "POST", body: request.body },
            signal,
            guard,
          );
        },
        readResponse: async (response) => {
          const payload = await readRestrictedResponse(response, signal, "transcription-timeout");
          if (typeof payload.text !== "string") {
            throw new RestrictedAudioError("invalid-response");
          }
          return payload;
        },
      },
    ),
  );
}
