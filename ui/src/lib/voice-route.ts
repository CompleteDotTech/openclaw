import { t } from "../i18n/index.ts";
import { registerChatComposerEnglish } from "../i18n/locales/en-chat-composer.ts";
import { UserFacingError } from "./connection-error.ts";

registerChatComposerEnglish();

export type VoiceRoute = "dictation" | "talk" | "command";

type VoiceDestination = Readonly<{
  kind: "draft" | "conversation" | "command";
  key: string | undefined;
}>;

type VoiceRouteIdentity = Readonly<{
  sessionId: string;
  generation: number;
  route: VoiceRoute;
  destination: VoiceDestination;
  cancellationOwner: object;
}>;

type CaptureAttempt = {
  ready: PromiseWithResolvers<void>;
  release: PromiseWithResolvers<void>;
};

// The browser lock also covers other same-origin Control UI windows. The local
// claim closes the gap before the asynchronous browser admission callback.
const CAPTURE_LOCK = "openclaw-voice-capture";
let captureOwner: CaptureAttempt | null = null;
let nextGeneration = 0;

/** Route identity owns results even after its stopped microphone is released. */
export class VoiceRouteSession {
  readonly identity: VoiceRouteIdentity;
  private readonly abort = new AbortController();
  private capture: CaptureAttempt | null = null;

  constructor(options: {
    route: VoiceRoute;
    destination: VoiceDestination;
    owner: object;
  }) {
    const destinationKind = {
      dictation: "draft",
      talk: "conversation",
      command: "command",
    }[options.route];
    if (options.destination.kind !== destinationKind) {
      throw new Error("Voice destination does not match the activated route.");
    }
    this.identity = Object.freeze({
      sessionId: crypto.randomUUID(),
      generation: ++nextGeneration,
      route: options.route,
      destination: Object.freeze({ ...options.destination }),
      cancellationOwner: options.owner,
    });
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get acceptsResults(): boolean {
    return !this.signal.aborted;
  }

  requireRoute(route: VoiceRoute): void {
    this.signal.throwIfAborted();
    if (route !== this.identity.route) {
      throw new Error("Voice result does not belong to the activated route.");
    }
    // P05 has no executor/authorization contract in this client yet. An internal
    // route value must not make that missing capability executable.
    if (route === "command") {
      throw new UserFacingError(t("chat.composer.voiceCommandUnavailable"));
    }
  }

  acquireCapture(): Promise<void> {
    try {
      this.requireRoute(this.identity.route);
      if (this.capture) {
        return this.capture.ready.promise;
      }
      if (captureOwner) {
        throw new UserFacingError(t("chat.composer.microphoneBusy"));
      }
      const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
      if (!locks) {
        throw new UserFacingError(t("chat.composer.voiceCoordinationUnavailable"));
      }
      const attempt: CaptureAttempt = {
        ready: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      this.capture = attempt;
      captureOwner = attempt;
      void (async () => {
        try {
          await locks.request(CAPTURE_LOCK, { mode: "exclusive", ifAvailable: true }, async (lock) => {
            // A canceled admission must not start later, or retire a newer claim.
            if (this.capture !== attempt || !this.acceptsResults) {
              return;
            }
            if (!lock) {
              throw new UserFacingError(t("chat.composer.microphoneBusy"));
            }
            attempt.ready.resolve();
            await attempt.release.promise;
          });
        } catch (error) {
          attempt.ready.reject(
            error instanceof UserFacingError
              ? error
              : new UserFacingError(t("chat.composer.voiceCoordinationUnavailable"), {
                  cause: error,
                }),
          );
        } finally {
          if (this.capture === attempt) {
            this.capture = null;
          }
          if (captureOwner === attempt) {
            captureOwner = null;
          }
        }
      })();
      return attempt.ready.promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Call after stopping owned media; pending text keeps its original result sink. */
  releaseCapture(): void {
    const attempt = this.capture;
    if (!attempt) {
      return;
    }
    this.capture = null;
    if (captureOwner === attempt) {
      captureOwner = null;
    }
    attempt.ready.reject(new DOMException("Voice capture was released.", "AbortError"));
    attempt.release.resolve();
  }

  cancel(): void {
    this.abort.abort(new DOMException("Voice session was canceled.", "AbortError"));
    this.releaseCapture();
  }

  complete(): void {
    this.abort.abort(new DOMException("Voice session was completed.", "AbortError"));
    this.releaseCapture();
  }
}
