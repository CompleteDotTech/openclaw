import type { TalkCatalogResult } from "@openclaw/gateway-protocol";

export type SpeechDataPolicyStatus = NonNullable<TalkCatalogResult["transcription"]["dataPolicy"]>;

export function speechDataPolicyRestrictsTalk(policy: SpeechDataPolicyStatus | undefined): boolean {
  return policy !== undefined && policy.mode !== "external";
}
