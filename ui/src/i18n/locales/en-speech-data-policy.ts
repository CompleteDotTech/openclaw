import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enSpeechDataPolicy = {
  chat: {
    speechDataPolicy: {
      title: "Dictation data policy",
      deviceLocal: "Device-local required",
      trustedEndpoint: "Trusted endpoint",
      external: "External processing",
      ready: "Ready",
      unverified: "Endpoint available · model unverified",
      unavailable: "Unavailable under this policy",
      notConfigured: "Not configured",
      model: "Model: {model}",
      modelUnknown: "Model details unavailable.",
      destination: "Destination: {destination}",
      destinationUnknown: "Destination details unavailable.",
      initializationUnverified: "Transcription inference has not been verified.",
      batch: "Batch transcription. Audio is transcribed after recording stops.",
      refinementUnavailable: "Transcript refinement is unavailable.",
      draft: "Text returns to your draft. You choose whether to send it.",
      talkUnavailable: "Live Talk and automatic spoken replies are unavailable under this policy.",
      policyCheckFailed: "Talk stopped because its speech data policy could not be verified.",
      dictationReviewRequired:
        "The dictation route changed or could not be verified. Review the destination and model before starting a new recording.",
      dictationOnly: "Hold to dictate",
      dictationUnavailable: "Dictation unavailable",
      dictationOnlyHint: "Hold to dictate into your draft. Live Talk is unavailable.",
      selectionReadiness:
        "After changing this model, review dictation readiness before starting a new recording.",
      localityUnverified: "Provider routing applies. Device locality has not been verified.",
    },
  },
} satisfies TranslationMap;

export const registerSpeechDataPolicyEnglish = Object.assign(
  () => Object.assign(en.chat, enSpeechDataPolicy.chat),
  { catalog: enSpeechDataPolicy },
);
