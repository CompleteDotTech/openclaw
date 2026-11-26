import { t } from "../../../i18n/index.ts";
import { selectComposerInput } from "../../../lib/composer-input.ts";
import type { ComposerMicrophoneOwner } from "../composer-microphone-picker.ts";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import { commitComposerDraft, composerDraftKey } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export function createComposerDictationOptions(
  props: ChatComposerProps,
  state: ChatComposerState,
  devicePicker: ComposerMicrophoneOwner,
  setError: (error: string | null) => void,
) {
  const client = props.gatewayClient ?? null;
  const sessionKey = props.sessionKey;
  const sessionId = props.currentSessionId ?? undefined;
  const draftKey = composerDraftKey(props);
  const draftScope = state.composerDraftScope;
  const ownsDraft = () =>
    (props.gatewayClient ?? null) === client &&
    props.sessionKey === sessionKey &&
    (props.currentSessionId ?? undefined) === sessionId &&
    composerDraftKey(props) === draftKey &&
    state.composerDraftScope === draftScope;
  return {
    client,
    sessionKey,
    sessionId,
    draftKey,
    readDraftRevision: () => state.editRevision,
    connected: props.connected,
    enabled: true,
    dictationAvailable: devicePicker.dictationStatus === "ready",
    realtimeTalkActive: props.realtimeTalkActive === true,
    onCommit: (transcript: string, late?: true, preservePreview?: true) => {
      if (!ownsDraft()) {
        return;
      }
      const target = state.composerTextarea;
      const captured = state.dictationSelection;
      // A newer recording may be painting a partial over its captured draft.
      const liveValue = preservePreview
        ? (captured?.value ?? props.getDraft?.() ?? props.draft)
        : (target?.value ?? props.getDraft?.() ?? props.draft);
      const insertion = state.dictation?.placeTranscript(
        transcript,
        captured,
        {
          start: target?.selectionStart ?? liveValue.length,
          end: target?.selectionEnd ?? liveValue.length,
          value: liveValue,
        },
        late,
        preservePreview,
      );
      if (!insertion) {
        return;
      }
      if (target) {
        target.value = insertion.value;
        adjustTextareaHeight(target);
      }
      commitComposerDraft(props, insertion.value);
      state.dictationSelection = insertion.captured;
      const insertedRevision = state.editRevision;
      queueMicrotask(() => {
        const textarea = state.composerTextarea;
        if (
          !ownsDraft() ||
          !textarea ||
          textarea !== target ||
          !textarea.isConnected ||
          props.realtimeTalkActive ||
          state.editRevision !== insertedRevision ||
          textarea.ownerDocument.activeElement !== textarea
        ) {
          return;
        }
        selectComposerInput(textarea, insertion.caret, insertion.caret);
      });
    },
    onError: (
      message: string,
      failure: { kind: "interrupted" | "start" | "busy"; preservesText: boolean },
    ) => {
      if (!ownsDraft()) {
        return;
      }
      if (failure.kind === "busy") {
        setError(message);
        return;
      }
      const recovery =
        failure.kind === "interrupted" && failure.preservesText
          ? t("chat.composer.dictationInterruptedRecovery")
          : t("chat.composer.dictationStartRecovery");
      setError(`${message} ${recovery}`);
    },
    onDictationUnavailable: devicePicker.handleOpen,
  };
}
