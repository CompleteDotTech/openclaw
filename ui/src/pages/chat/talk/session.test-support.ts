import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../../test-helpers/gateway-client.ts";
import type { RealtimeTalkGatewayRelaySessionResult } from "./shared.ts";

/** Lifecycle fixtures exercise provider calls after an ordinary, unrestricted catalog read. */
export function createUnrestrictedTalkTestClient(request: unknown) {
  // SAFETY: Callers supply RPC functions; individual tests narrow their known request payloads.
  const respond = request as GatewayRequestHandler;
  return createTestGatewayClient((method, params, options) =>
    method === "talk.catalog"
      ? {
          modes: ["realtime", "stt-tts", "transcription"],
          transports: ["gateway-relay", "webrtc", "provider-websocket"],
          brains: ["none", "agent-consult"],
          realtime: { providers: [] },
          transcription: { providers: [] },
          speech: { providers: [] },
        }
      : respond(method, params, options),
  );
}

export function createGatewayRelaySession(
  provider = "openai",
  relaySessionId = "relay-1",
): RealtimeTalkGatewayRelaySessionResult {
  return {
    provider,
    transport: "gateway-relay",
    relaySessionId,
    audio: {
      inputEncoding: "pcm16",
      inputSampleRateHz: 24000,
      outputEncoding: "pcm16",
      outputSampleRateHz: 24000,
    },
  };
}
