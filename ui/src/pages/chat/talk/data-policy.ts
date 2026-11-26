import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { t } from "../../../i18n/index.ts";
import { registerSpeechDataPolicyEnglish } from "../../../i18n/locales/en-speech-data-policy.ts";
import { speechDataPolicyRestrictsTalk } from "../../../lib/speech-data-policy.ts";

registerSpeechDataPolicyEnglish();

/** One call owns policy checks and invalidation, including split Talk's automatic sends. */
export class TalkDataPolicyGuard {
  private disposed = false;
  private pending: Promise<TalkCatalogResult> | undefined;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly sessionKey: string,
    onRevoked: (error: Error) => void,
  ) {
    this.unsubscribe = client.addEventListener((event) => {
      if (event.event !== "config.changed" || this.disposed) {
        return;
      }
      // Replacing pending synchronously prevents a completed older check from admitting a send.
      void this.check().catch((error: unknown) => {
        if (!this.disposed) {
          onRevoked(
            error instanceof Error
              ? error
              : new Error(t("chat.speechDataPolicy.policyCheckFailed")),
          );
        }
      });
    });
  }

  async check(): Promise<TalkCatalogResult> {
    if (this.disposed) {
      throw new Error(t("chat.speechDataPolicy.policyCheckFailed"));
    }
    let pending = this.client.request<TalkCatalogResult>(
      "talk.catalog",
      { sessionKey: this.sessionKey },
      { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS },
    );
    this.pending = pending;
    for (;;) {
      let catalog: TalkCatalogResult;
      try {
        catalog = await pending;
      } catch {
        if (!this.disposed && pending !== this.pending && this.pending) {
          pending = this.pending;
          continue;
        }
        throw new Error(t("chat.speechDataPolicy.policyCheckFailed"));
      }
      if (this.disposed) {
        throw new Error(t("chat.speechDataPolicy.policyCheckFailed"));
      }
      if (pending !== this.pending && this.pending) {
        pending = this.pending;
        continue;
      }
      if (speechDataPolicyRestrictsTalk(catalog.transcription?.dataPolicy)) {
        throw new Error(t("chat.speechDataPolicy.talkUnavailable"));
      }
      return catalog;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
  }
}
