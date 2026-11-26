import { createMemo, Show } from "solid-js";
import { registerSpeechDataPolicyEnglish } from "../i18n/locales/en-speech-data-policy.ts";
import { formatUiExternalText } from "../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import {
  speechDataPolicyRestrictsTalk,
  type SpeechDataPolicyStatus,
} from "../lib/speech-data-policy.ts";

registerEnglishCatalog(registerSpeechDataPolicyEnglish);

export function speechDataPolicyLabel(policy: SpeechDataPolicyStatus): string {
  return t(
    !policy.configured
      ? "chat.speechDataPolicy.notConfigured"
      : !policy.available || !policy.permitted
        ? "chat.speechDataPolicy.unavailable"
        : !policy.initialized
          ? "chat.speechDataPolicy.unverified"
          : "chat.speechDataPolicy.ready",
  );
}

/** Metadata only. An endpoint's model list is not evidence of working inference. */
export function speechDataPolicyDescription(policy: SpeechDataPolicyStatus): string {
  return [
    t(
      policy.mode === "device-local"
        ? "chat.speechDataPolicy.deviceLocal"
        : policy.mode === "trusted-endpoint"
          ? "chat.speechDataPolicy.trustedEndpoint"
          : "chat.speechDataPolicy.external",
    ),
    speechDataPolicyLabel(policy),
    policy.model
      ? t("chat.speechDataPolicy.model", { model: formatUiExternalText(policy.model) })
      : t("chat.speechDataPolicy.modelUnknown"),
    policy.destination
      ? t("chat.speechDataPolicy.destination", {
          destination: formatUiExternalText(policy.destination),
        })
      : t("chat.speechDataPolicy.destinationUnknown"),
    formatUiExternalText(policy.message),
    !policy.initialized ? t("chat.speechDataPolicy.initializationUnverified") : undefined,
    t("chat.speechDataPolicy.batch"),
    t("chat.speechDataPolicy.refinementUnavailable"),
    t("chat.speechDataPolicy.draft"),
    speechDataPolicyRestrictsTalk(policy) ? t("chat.speechDataPolicy.talkUnavailable") : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

export function SpeechDataPolicyNotice(props: {
  policy?: SpeechDataPolicyStatus;
  id?: string;
  class?: string;
}) {
  const description = createMemo(() => props.policy && speechDataPolicyDescription(props.policy));
  return (
    <Show when={description()}>
      {(message) => (
        <div id={props.id} class={props.class} role="status" aria-live="polite" aria-atomic="true">
          {message()}
        </div>
      )}
    </Show>
  );
}
