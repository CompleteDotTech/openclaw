import type { SpeechDataPolicyStatus } from "../lib/speech-data-policy.ts";

/** Synthetic endpoint metadata, deliberately not evidence of initialized inference. */
export function speechDataPolicyFixture(
  overrides: Partial<SpeechDataPolicyStatus> = {},
): SpeechDataPolicyStatus {
  return {
    mode: "trusted-endpoint",
    configured: true,
    initialized: false,
    available: true,
    permitted: true,
    transport: "batch",
    provider: "openai",
    model: "synthetic-whisper",
    destination: "http://127.0.0.1:8080/v1",
    reason: "model-unverified",
    message: "The endpoint lists the selected model.",
    refinement: "unavailable",
    ...overrides,
  };
}
