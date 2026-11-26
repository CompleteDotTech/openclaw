> **Maintainer question:** Will the macOS native owner, together with P01, accept a first M10 slice owned by Quick Chat that inserts a user-reviewed dictation candidate only into the originally captured TextEdit plain-text document control on macOS 27.2.1, using a qualified Accessibility selected-text operation, with explicit copy recovery and broader routes deferred; and what observable postcondition is sufficient to call that insertion confirmed?

# M10 native-control decision

**Proposal: PLAN ONLY. Owner acceptance: NEEDS MAINTAINER. Native proof: NOT COLLECTED.**

This committed proposal responds to [M10's durable ClawSweeper review](https://github.com/openclaw/openclaw/issues/205846#issuecomment-7186467107). The review still asks for the native-owner/control/outcome decision before implementation. The user's latest instruction authorizes the requested commits and prohibits comments; it does not establish upstream product acceptance. No new M10 implementation or PR is represented by this document.

## Recommendation and alternatives

| Option | Concrete scope | Benefit | Limitation / cost | Disposition |
| --- | --- | --- | --- | --- |
| A | Quick Chat owns one direct AX selected-text attempt into the original TextEdit plain-text document control | One existing native lifecycle/effect owner; insertion does not change the clipboard or post keys | Actual writability, selection continuity through the overlay, minimal read-back and non-atomic race behavior must qualify | Recommend conditionally, pending the owner decision and real proof |
| B | Quick Chat retains a preview and offers explicit Copy for user-controlled paste | Honest recoverable text where direct insertion cannot qualify | User performs transfer; Copy replaces clipboard contents and history may retain text; no original-control insertion claim | Required recovery; only delivery when A is unavailable |
| C | Disclosed clipboard-assisted paste for that same control | Could reuse existing native event-paste machinery | Clipboard races/format preservation, focus restoration and missing acknowledgment add a separate contract | Defer; never a hidden fallback from A |

The proposed qualification tuple is macOS 27.2.1, one TextEdit document explicitly in plain-text mode, its captured main editing control, and a direct AX selected-text operation. Actual Mac/OS build, TextEdit version, AX role, writable attributes and observed postcondition are **NOT COLLECTED**. This is not support for every TextEdit mode, NSTextView, browser/Electron field, secure input, terminal or other operating system. Refresh stable versions when a later accepted task actually executes.

## Existing behavior and owner

Source inspection at [30daf88b038a5b5ca4eec818fff38bab1543b393](https://github.com/openclaw/openclaw/tree/30daf88b038a5b5ca4eec818fff38bab1543b393) confirms:

- [QuickChatController.toggleDictation](https://github.com/openclaw/openclaw/blob/30daf88b038a5b5ca4eec818fff38bab1543b393/apps/macos/Sources/OpenClaw/QuickChatController.swift#L345) captures the selection of Quick Chat's own NSTextView and updates its composer.
- [Completed-reply paste](https://github.com/openclaw/openclaw/blob/30daf88b038a5b5ca4eec818fff38bab1543b393/apps/macos/Sources/OpenClaw/QuickChatController.swift#L419) chooses the frontmost app when invoked, replaces the general clipboard, activates/checks the process and posts Command-V. It does not retain the external control from dictation start or acknowledge its accepted edit.
- [Manual Stop](https://github.com/openclaw/openclaw/blob/30daf88b038a5b5ca4eec818fff38bab1543b393/apps/macos/Sources/OpenClaw/QuickChatDictation.swift#L92) cancels recognition. A frozen candidate approved by the user must not be described as a newly guaranteed provider-final transcript.
- [Outside interaction](https://github.com/openclaw/openclaw/blob/30daf88b038a5b5ca4eec818fff38bab1543b393/apps/macos/Sources/OpenClaw/QuickChatController.swift#L531) currently dismisses Quick Chat. Preserving this new workflow's recovery preview needs a bounded adjustment accepted in the same owner; ordinary dismissal must not change implicitly.

Recommend QuickChatController/QuickChatModel for the native request, presentation and effect; retain QuickChatDictation/SpeechCaptureResources and PermissionManager for capture and OS permission work. No public SDK, Gateway method, plugin coordinator, model runner, second capture manager or paste queue is proposed.

The immediate consumer is Quick Chat's explicit native review action. P01 [#205853](https://github.com/openclaw/openclaw/issues/205853) is the first proposed shortcut/overlay consumer after agreement on capture-before-overlay timing and outcomes. M11 [#205845](https://github.com/openclaw/openclaw/issues/205845) may later supply an approved candidate without owning another writer. P06 remains the original package's proposed dictation/agent-mode owner; this flow is unsent dictation, adds no mode router or agent invocation, and implies no verified P06 implementation parent. M10 does not require M11 refinement or a particular P01 capture UI.

## Target and effect contract

Bind the original application instance, window/control reference, selection/caret and the minimum observable placement evidence before the overlay changes focus. A PID, private title, app name or newly frontmost control is not a substitute. Keep native handles and bounded correctness data local and in memory; never traverse unrelated text to classify a destination.

Immediately before the single effect, preserve the existing owner's candidate/presentation/capture identity, cancellation and actual target/selection correctness. Do not add a feature-permission generation service. A foreign app/window/control or changed selection retires automatic insertion for the candidate; returning does not silently rearm it. The expected Quick Chat overlay transition is permitted only if demonstrated for this exact control. If the existing lifecycle observations cannot establish continuity, preserve text for explicit Copy.

AX check, write and read-back are separate operations, not an atomic compare-and-replace. The owner must choose what bounded read-back can prove the approved replacement at the original selection. If the control cannot provide that evidence without excessive document inspection, the route stays unavailable. A wrong-target or wrong-selection write blocks release even if subsequently called unknown. Whole-value replacement, synthetic focus restoration, key injection and another insertion method are not fallback implementations.

| Outcome | Evidence required | Recovery |
| --- | --- | --- |
| Confirmed | One attempted write and an accepted control-specific postcondition demonstrate the approved text at the original location in the same control, preserving the supported adjacent context and unsent behavior | Announce once; consume the attempt; retain preview until dismissal |
| Failed before effect | The mutation was never invoked: cancelled, unsupported, denied before dispatch, changed/missing target or failed placement precondition | Keep the text and explain why; explicit Copy or a newly admitted workflow |
| Unknown / possibly applied | A mutation was invoked but acknowledgment/read-back is absent, ambiguous, mismatched or interrupted | Explain possible insertion; inspect the original document; no automatic retry, alternate route, rollback or copy |

An API/event return alone is insufficient for confirmed insertion. An error received after dispatch is insufficient for definite no-effect. Consume the existing owner's attempt before dispatch; duplicate callbacks cannot repeat it. Cancellation after an indivisible dispatch cannot promise rollback. Restart discards the in-memory candidate/target and replays nothing; it does not provide durable preview recovery.

## Clipboard, state and authority

Direct insertion makes no clipboard write. Explicit Copy replaces the current clipboard and can leave data in history/manager software. Explain that impact, including possible duplication if the preceding insertion is unknown. It does not paste, restore old formats, erase history or guarantee external Undo. Never restore over a newer user copy. Clipboard-assisted paste, rich/delayed-format preservation and restoration are deferred.

Admit feature policy once when work starts; setting removal/reload affects the next request. Keep explicit cancellation, actual target invalidity and OS enforcement. Microphone/Speech/Accessibility prompts and signed identity stay with existing native owners.

Preserve the separate existing transport contract: credential-dispatch guards, assertCurrent, inbound provider-frame authority, transcript publication and authorized Stop/final-drain behavior. P02 [#205876](https://github.com/openclaw/openclaw/pull/205876) repairs those boundaries; neither its draft nor admission-once policy authorizes late dispatch/publication after transport authority fails. Existing input/request-generation checks are correctness checks, not a reason to introduce or remove permission machinery.

No persistent target database, receipt store, transcript journal, background retry, lease or new native preference schema is proposed. Default Quick Chat composer dictation stays intact; the native route would be an explicitly selected workflow after acceptance and qualification.

The two shared preparation files were unavailable. The supplied fallback remains an unaccepted browser/Gateway-scoped UiSettings / UiPreferences.dictationPreparation proposal: version 1; prose literal profile; punctuation preserve; cleanup/correction/structure/refinement off. Proposed alternatives are prose/developer-review, preserve/review and off/review. Missing values preserve existing prose defaults. The proposed 1 KiB self-limit does not replace Gateway limits of 4096 UTF-8 bytes/value, 128 keys/profile and 32 entries/update. Exclusion from server ui.prefs synchronization still requires verification if adopted. This native slice imports none of that policy, content storage or semantic/model behavior; exact developer-token preservation is not established by existing prose spacing.

## Decisions that unlock later implementation

The native owner and P01 must accept the existing owner/first consumer, named control/route, capture-before-overlay and selection/focus contract, privacy-bounded confirmed postcondition, latest-recognition candidate semantics, recovery-preview lifetime and explicit deferrals. They must decide whether the non-atomic AX limitation can meet the promised behavior; hardware access cannot replace that product judgment.

Once the native owner and P01 accept this scope, implementation can proceed under the user's existing request in permitted source isolation, followed by real signed-app qualification using [the runbook](checks/qualification-runbook.md). Acceptance does not itself certify the route. No M10 PR is created in this iteration; any later publication must satisfy the accepted scope and current publication rules. The user's comments prohibition remains in force. Windows/Linux/mobile methods, browser/native bridges, public coordinator APIs, automatic Undo, persistence and semantic refinement remain deferred.
