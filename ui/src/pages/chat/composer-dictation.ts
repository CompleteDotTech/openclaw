import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { GatewaySpeechPlayback } from "../../lib/speech-playback.ts";
import type {
  ComposerDictationCommits,
  ComposerDictationSession,
  placeComposerDictation,
} from "./composer-dictation-session.ts";
import type { RealtimeTalkLevelSignal } from "./talk/level.ts";

type DictationPhase = "idle" | "starting" | "connecting" | "recording" | "stopping";

type ComposerDictationFailure = {
  kind: "interrupted" | "start" | "busy";
  preservesText: boolean;
};

type ComposerDictationOwnerOptions = {
  client: GatewayBrowserClient | null;
  sessionKey?: string;
  sessionId?: string;
  prepareSession?: () => Promise<string | undefined>;
  draftKey?: string;
  connected: boolean;
  presented?: boolean;
  enabled: boolean;
  dictationAvailable?: boolean;
  realtimeTalkActive: boolean;
  readDraftRevision?: () => number | string;
  onCommit: (text: string, late?: true, preservePreview?: true) => void;
  onError: (message: string, failure: ComposerDictationFailure) => void;
  onDictationUnavailable?: () => void;
};

type DictationCapture = {
  options: ComposerDictationOwnerOptions;
  session?: ComposerDictationSession;
};

// Session admission must remain synchronous across user and media callbacks.
export class ComposerDictationOwner extends EventTarget {
  private readonly playback = new GatewaySpeechPlayback();
  private phase: DictationPhase = "idle";
  private cancellationListeners: AbortController | null = null;
  private capture: DictationCapture | undefined;
  // Created with the lazy capture module, before the first transcript exists.
  private commits: ComposerDictationCommits | undefined;
  private continuationGeneration = 0;
  private disposed = false;

  constructor(private options: ComposerDictationOwnerOptions) {
    super();
  }

  subscribe(listener: () => void) {
    return listen(this, "change", listener);
  }

  get active(): boolean {
    return this.phase === "connecting" || this.phase === "recording" || this.phase === "stopping";
  }

  get connecting(): boolean {
    return this.phase === "connecting";
  }

  get finalizing(): boolean {
    return this.phase === "stopping";
  }

  // Stop releases the microphone and typing lock before the final text arrives.
  get transcribing(): boolean {
    return Boolean(this.commits?.size);
  }

  get locksComposer(): boolean {
    return this.phase !== "idle";
  }

  /** Places a transcript in a draft; there is nothing to place before capture loads. */
  placeTranscript(
    ...args: Parameters<typeof placeComposerDictation>
  ): ReturnType<typeof placeComposerDictation> | undefined {
    return this.commits?.place(...args);
  }

  get inputLevel(): RealtimeTalkLevelSignal | undefined {
    return this.capture?.session?.inputLevel;
  }

  get transcript(): string {
    return this.capture?.session?.transcriptSnapshot() ?? "";
  }

  // Returns the stop promise so the confirming control can remain tied to the
  // session that actually inserted text into the draft.
  finishActive(options: { forSend?: true } = {}): Promise<boolean> {
    if (!options.forSend) {
      return this.stop({ commit: true });
    }
    const capture = this.capture;
    const readRevision = capture?.options.readDraftRevision;
    const revision = readRevision?.();
    const continuationGeneration = this.continuationGeneration;
    return this.stop({
      commit: true,
      canContinue: () => readRevision !== undefined && readRevision() === revision,
    }).then(
      (committed) =>
        committed &&
        capture !== undefined &&
        continuationGeneration === this.continuationGeneration &&
        this.sameScope(capture.options) &&
        this.options.presented !== false &&
        this.options.enabled,
    );
  }

  startDirect(): boolean {
    if (this.phase !== "idle" || !this.canStart()) {
      return false;
    }
    const capture: DictationCapture = {
      options: { ...this.options },
    };
    this.continuationGeneration += 1;
    this.capture = capture;
    this.setPhase("starting");
    void this.start(capture);
    return true;
  }

  update(options: ComposerDictationOwnerOptions): void {
    if (!this.sameScope(options)) {
      this.cancel();
    }
    if (this.options.presented !== false && options.presented === false) {
      this.continuationGeneration += 1;
    }
    this.options = options;
    if (!options.connected) {
      this.commits?.markGatewayDisconnected();
    }
    if (this.phase === "stopping") {
      return;
    }
    if (this.phase !== "idle" && !this.canStart()) {
      const keepFinal = this.active && (!options.connected || options.presented === false);
      const preservesText =
        keepFinal && !options.connected
          ? (this.capture?.session?.markGatewayDisconnected() ?? false)
          : false;
      void this.stop({ commit: keepFinal });
      // Empty drains report through the session; retained text still needs this notice.
      if (keepFinal && preservesText && !options.connected) {
        options.onError(t("chat.composer.dictationDisconnected"), {
          kind: "interrupted",
          preservesText,
        });
      }
    }
  }

  setPresented(presented: boolean): void {
    this.update({ ...this.options, presented });
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  cancel(): void {
    this.continuationGeneration += 1;
    this.playback.stop();
    if (this.commits?.size) {
      this.commits.retire();
      this.pendingCommitsChanged();
    }
    void this.stop({ commit: false });
  }

  private readonly handleDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || (this.phase === "idle" && !this.transcribing)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.cancel();
  };

  // Leaving the window interrupts capture but keeps dictated text in the draft.
  // The browser's microphone permission prompt (Safari, Chrome) blurs the window
  // while the microphone is still opening, so a blur waits until listening: Allow
  // then starts listening and a denial reports its error. A hidden page still ends
  // dictation at any point.
  private readonly handleWindowLeave = (event: Event): void => {
    if (
      event.type === "visibilitychange" ? document.visibilityState !== "hidden" : this.connecting
    ) {
      return;
    }
    this.continuationGeneration += 1;
    void this.finishActive();
  };

  private sameScope(options: ComposerDictationOwnerOptions): boolean {
    return (
      this.options.client === options.client &&
      this.options.sessionKey === options.sessionKey &&
      this.options.sessionId === options.sessionId &&
      this.options.draftKey === options.draftKey
    );
  }

  private canStart(): boolean {
    return (
      !this.disposed &&
      this.options.enabled &&
      this.options.connected &&
      this.options.presented !== false &&
      !this.options.realtimeTalkActive &&
      this.options.client !== null
    );
  }

  private async start(capture: DictationCapture): Promise<void> {
    if (this.capture !== capture) {
      return;
    }
    const client = capture.options.client;
    if (this.phase !== "starting" || !client || !this.canStart()) {
      await this.stop({ commit: false });
      return;
    }
    const { options } = capture;
    if (options.dictationAvailable === false && !options.prepareSession) {
      this.capture = undefined;
      this.setPhase("idle");
      options.onDictationUnavailable?.();
      return;
    }
    // Escape/visibility/blur guard the live capture lifecycle.
    this.setPhase("connecting");
    if (this.capture !== capture) {
      return;
    }
    let describeStartError = (error: unknown): [string, ComposerDictationFailure["kind"]] => [
      formatUiError(error),
      "start",
    ];
    try {
      // Preserve Safari playback activation before the lazy capture module loads.
      this.playback.prepare(client, () => {
        if (this.capture === capture) {
          void this.stop({ commit: false });
        }
      });
      const sessionKey = options.prepareSession ? await options.prepareSession() : options.sessionKey;
      const { ComposerDictationSession, ComposerDictationCommits, describeDictationStartError } =
        await import("./composer-dictation-session.ts");
      if (
        this.capture !== capture ||
        this.disposed ||
        !this.connecting ||
        !this.canStart()
      ) {
        return;
      }
      describeStartError = describeDictationStartError;
      const commits = (this.commits ??= new ComposerDictationCommits());
      const session = new ComposerDictationSession(
        client,
        {
          onError: (message, preservesText) => {
            if (this.capture !== capture && !commits.has(session)) {
              return;
            }
            try {
              options.onError(message, { kind: "interrupted", preservesText });
            } finally {
              if (this.capture === capture) {
                void this.stop({ commit: true });
              } else if (commits.has(session)) {
                this.dispatchEvent(new Event("change"));
              }
            }
          },
          onTranscriptChange: () => {
            if (this.capture === capture) {
              this.dispatchEvent(new Event("change"));
            }
          },
          onReady: () => {
            if (this.capture === capture && this.phase === "connecting") {
              this.setPhase("recording");
            }
          },
        },
        { sessionKey },
      );
      capture.session = session;
      await session.start();
    } catch (error) {
      if (this.capture !== capture || this.disposed || this.finalizing) {
        return;
      }
      const [message, kind] = describeStartError(error);
      try {
        options.onError(message, { kind, preservesText: false });
      } finally {
        if (this.capture === capture) {
          await this.stop({ commit: false });
        }
      }
    }
  }

  private stop(options: { commit: boolean; canContinue?: () => boolean }): Promise<boolean> {
    if (this.phase === "idle" || this.phase === "stopping") {
      return Promise.resolve(false);
    }
    const wasActive = this.active;
    const capture = this.capture;
    this.capture = undefined;
    if (!capture?.session) {
      this.setPhase("idle");
      this.releasePlayback();
      return Promise.resolve(false);
    }
    const session = capture.session;
    // Publish Stop only after its pending commit is registered, so a change
    // listener can cancel or replace the draft without missing this recording.
    this.phase = "stopping";
    if (!options.commit) {
      void session.cancel().catch(() => undefined);
      this.setPhase("idle");
      this.releasePlayback();
      return Promise.resolve(false);
    }
    // Capture and typing unlock immediately. Stopped recordings retain ownership
    // and commit in capture order, even when a later provider finishes first.
    const committed = this.commits!.add(session, (lateTranscript) => {
      try {
        if (!lateTranscript || !wasActive || this.disposed || !this.options.enabled) {
          return false;
        }
        // Read before insertion: the transcript itself changes the draft revision.
        // Later typing is preserved but needs another explicit Send activation.
        const canContinue = options.canContinue?.() ?? true;
        if (this.active) {
          capture.options.onCommit(lateTranscript, true, true);
        } else {
          capture.options.onCommit(lateTranscript, true);
        }
        return canContinue;
      } finally {
        this.pendingCommitsChanged();
      }
    });
    // finish() stops capture synchronously. Its pending result keeps the original
    // draft sink without retaining microphone or playback ownership.
    this.setPhase("idle");
    this.releasePlayback();
    this.pendingCommitsChanged();
    return committed;
  }

  private releasePlayback(): void {
    if (this.phase === "idle") {
      this.playback.stop();
    }
  }

  private pendingCommitsChanged(): void {
    this.syncCancellationListeners();
    this.dispatchEvent(new Event("change"));
  }

  private setPhase(phase: DictationPhase): void {
    if (this.phase === phase) {
      return;
    }
    this.phase = phase;
    this.syncCancellationListeners();
    this.dispatchEvent(new Event("change"));
  }

  private syncCancellationListeners(): void {
    if (this.phase !== "idle" || this.transcribing) {
      if (this.cancellationListeners) {
        return;
      }
      this.cancellationListeners = new AbortController();
      const options = { signal: this.cancellationListeners.signal };
      listen(document, "keydown", this.handleDocumentKeyDown, options);
      listen(document, "visibilitychange", this.handleWindowLeave, options);
      listen(window, "blur", this.handleWindowLeave, options);
    } else {
      this.cancellationListeners?.abort();
      this.cancellationListeners = null;
    }
  }
}
