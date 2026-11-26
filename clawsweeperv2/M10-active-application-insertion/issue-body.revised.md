> **Maintainer question:** Will the macOS native owner, together with P01, accept a first M10 slice owned by Quick Chat that inserts a user-reviewed dictation candidate only into the originally captured TextEdit plain-text document control on macOS 27.2.1, using a qualified Accessibility selected-text operation, with explicit copy recovery and broader routes deferred; and what observable postcondition is sufficient to call that insertion confirmed?

# [Feature]: Qualify reviewed dictation insertion into one original macOS TextEdit control

**Replacement draft for [M10 #205846](https://github.com/openclaw/openclaw/issues/205846), committed for review but not posted to the issue. Proposal PLAN ONLY; acceptance NEEDS MAINTAINER; product proof NOT COLLECTED.**

## Problem and baseline

Quick Chat can dictate into its own composer and separately paste a completed assistant reply. Its reply-paste action selects the frontmost application when invoked, replaces the clipboard and posts Command-V after process checks. It does not establish the original external control/selection present when dictation started, or acknowledge that control's accepted edit. [Current native source](https://github.com/openclaw/openclaw/blob/30daf88b038a5b5ca4eec818fff38bab1543b393/apps/macos/Sources/OpenClaw/QuickChatController.swift#L345)

The residual capability is one explicit approved insertion into that original control with an honest outcome. [ClawSweeper's review](https://github.com/openclaw/openclaw/issues/205846#issuecomment-7186467107) asks for one native-owner/control/route decision with P01 before implementation, preview/copy recovery, minimal state and real qualification. No observed human decision has accepted it.

## Proposed first slice and alternatives

Recommend the existing Quick Chat native owner and one TextEdit plain-text document's main editor on proposed macOS 27.2.1, using one qualified Accessibility selected-text operation. Actual TextEdit version, AX role/writability, selection/overlay behavior and acknowledgment are NOT COLLECTED.

| Option | Benefit | Limitation | Choice |
| --- | --- | --- | --- |
| Direct AX selected-text operation | Original retained control, no clipboard insertion transaction | Must qualify writability, placement and read-back; check/write is non-atomic | Conditional recommendation |
| Preview plus explicit Copy | Recoverable text with user-controlled transfer | Replaces clipboard; no automatic original-control insertion | Required fallback |
| Clipboard-assisted paste | Reuses a native event primitive | Adds focus/clipboard races and acknowledgment limits | Deferred; never silently substituted |

No claim covers all NSTextView/TextEdit modes, browser/Electron editors, terminals, secure inputs, Windows, Linux or mobile input methods.

## User flow

1. The user places a caret or selection in the named TextEdit plain-text control and invokes the accepted native workflow.
2. Before showing the overlay, Quick Chat binds the original app instance/window/control and minimum observable selection/placement evidence through its existing owner.
3. Existing native capture and PermissionManager handle real microphone/Speech access. Feature policy is admitted once.
4. The user stops and reviews one frozen recognized candidate. Current Stop cancels recognition; do not promise a newly delivered provider-final transcript.
5. The preview presents the destination and accessible Insert, Copy and Cancel controls. It preserves literal/recoverable text and clearly shows unsupported or denied capability.
6. Explicit Insert validates the current candidate/lifecycle and original target/selection immediately before at most one direct effect.
7. Report confirmed, failed before effect or unknown/possibly applied. Never Enter, Send, Submit, execute a command or silently activate/retarget another app.

Foreign app/control focus or a changed original selection retires this candidate's insertion eligibility. Returning cannot revive it. Qualify Quick Chat's own overlay transition separately. Ordinary Quick Chat currently dismisses on outside interaction; preserving this flow's recovery preview needs a bounded same-owner lifecycle decision without silently changing ordinary dismissal.

## Ownership, authority and data

QuickChatController/QuickChatModel own presentation, candidate and effect. QuickChatDictation/SpeechCaptureResources retain capture; PermissionManager retains native OS prompts. P01 calls the accepted native entrypoint later; M11 may provide a user-approved candidate but cannot paste independently. P06 remains the package's proposed mode-choice owner; this unsent dictation flow introduces no mode router or agent invocation. No particular refiner or P01 capture UI is required.

Keep only current target/candidate and consumed/attempted state in the existing owner's memory. No generic coordinator/API, second queue, persistence, receipt ledger, transcript history, lease or permission-generation service. Restart loses the preview and replays nothing.

Admit feature policy once; removals/reloads govern the next request. Preserve explicit cancellation, OS enforcement, actual target validity and all existing transport and publication guards. P02's credential-dispatch/assertCurrent/inbound-frame contract is independent of feature consent. Existing request/input-generation checks prevent stale publication and remain required.

Default composer dictation remains intact. No new persistent native setting, Gateway RPC, server ui.prefs entry or SDK contract is introduced. The separate browser preparation-policy fallback remains unaccepted and out of this slice; its defaults, size limits and proposed sync exclusion are detailed in [the decision brief](decision-brief.md).

Native handles, preview and bounded placement evidence remain local. Default diagnostics exclude dictated text, document titles/content, clipboard contents, command lines, credentials and private endpoints. Qualification uses benign text in the real product, redacted before saving.

## Selection and effect semantics

Original identity is more than a PID or title. Retain the actual app instance/control and observable original selection; do not locate a replacement at commit time. No whole-value setter, synthetic selection movement, focus-restoration keystroke or automatic alternate method.

AX inspection, mutation and read-back are separate operations. The native owner must accept and demonstrate a bounded non-atomic contract. If original-selection correctness or minimal read-back cannot be established, leave automatic insertion unavailable. Calling a wrong-location write unknown does not make it acceptable.

| Outcome | Evidence | Recovery |
| --- | --- | --- |
| Confirmed | Accepted control-specific postcondition establishes the approved edit at the original location in the same control, with supported adjacent context preserved and no submission | Announce once, consume attempt, retain preview |
| Failed before effect | The mutating operation was never invoked | Explain refusal and preserve text; explicit Copy or new admission |
| Unknown / possibly applied | Dispatch occurred, but effect/acknowledgment is missing, ambiguous, mismatched or interrupted | Explain possible insertion, inspect destination, no automatic retry or alternate method |

Consume before dispatch to prevent duplicate effects. API/event success alone is insufficient acknowledgment; a post-dispatch error alone is insufficient proof of no effect. Cancellation after dispatch cannot promise rollback. No global Undo shortcut is sent.

Direct AX insertion does not write the clipboard. Explicit Copy replaces its current contents and may remain in clipboard history; it does not paste, restore prior formats or erase history. After unknown insertion, warn about possible duplication before manual transfer. Never restore over a later user copy. Clipboard-assisted paste/restoration and host Undo remain deferred.

## Proposed acceptance and evidence

Every row is PLAN ONLY; runtime evidence is NOT COLLECTED. The historical AC01–AC14 remain mapped in [requirements](clawsweeper-requirements.md), with other-platform/restoration asks explicitly deferred rather than passed.

| Gate | Required result |
| --- | --- |
| N01 Owner decision | Human native/P01 acceptance of the owner, control/OS tuple, route, focus/candidate/outcome and recovery lifetime |
| N02 Real native path | Signed app, physical mic, real Apple Speech/capture provider, real task-owned Gateway and declared TextEdit control complete the actual flow |
| N03 Exact placement | One caret insertion or original-selection replacement preserves supported adjacent text and approved multiline/Unicode content |
| N04 Original target | Overlay, foreign focus, changed selection, closed/reused control and return-to-old-app cases cannot retarget/revive an old attempt |
| N05 Honest outcomes | Observed edit, known pre-effect refusal and uncertain dispatched response remain distinct; no blind retry |
| N06 Cancellation/restart | Duplicate actions do not duplicate; pre-effect cancellation prevents dispatch; post-effect cancellation makes no rollback promise; restart replays nothing |
| N07 Unsent/refusals | No Enter/send/submit/activation fallback; secure/execution-capable/unsupported controls do not receive a hidden write |
| N08 Permissions/transport | OS denial/revocation is honored; new requests use current admission; existing authority, Stop and publication behavior remains |
| N09 Recovery | Selectable preview and explicit Copy disclose clipboard impact; user copies survive direct insertion and no restoration overwrites them |
| N10 Accessibility | Keyboard/VoiceOver destination, review, outcome, copy and cancellation; large text, contrast, RTL, Unicode and composition tested |
| N11 Privacy/defaults | Content-free default diagnostics, ephemeral state, preserved composer/reply-paste meanings and disabled-feature behavior |
| N12 Upgrade/proof | Current stable upgrade preserves expected settings/signing identity; exact accepted source checks and real native evidence are recorded |

The old 2 KiB p95 ≤150 ms target is UNMEASURED. If adopted, measure cold/warm confirmed operations separately from refusals/failures/unknowns. Wrong-target writes block readiness regardless of speed.

Use [qualification-runbook.md](checks/qualification-runbook.md). It specifies actual future commands and native scenario evidence; no mocked control or browser fixture certifies this route. Source execution first needs permitted isolation/trust, then the real signed hardware flow. No native implementation/test/build/product/upgrade evidence was produced by this proposal commit.

## Dependencies and current changes

- [P01 #205853](https://github.com/openclaw/openclaw/issues/205853): native workflow/control decision remains open with M10.
- [M11 #205845](https://github.com/openclaw/openclaw/issues/205845): refinement owner and admission/cancellation decision remains open; delivery stays with its actual owner.
- [Browser PR #204107](https://github.com/openclaw/openclaw/pull/204107) **merged at 2026-11-26T12:52:40Z**, merge commit 762aa006f9482f44d7975efe9cef2679d498c885. Its earlier open/unmerged/CI discussion is historical. Landing browser lifecycle work is not native M10 acceptance.
- [M11 PR #205973](https://github.com/openclaw/openclaw/pull/205973) is an open draft at 7dab77ee268617d70ab5f035bb7864cc278aa327. Its [review](https://github.com/openclaw/openclaw/pull/205973#issuecomment-7193928672) identifies a 2500 ms completion timeout versus a 5000 ms relay drain, plus owner/live-proof gates. That is an M11 defect, not a reviewed M10 implementation or an accepted shared coordinator.
- [P02 PR #205876](https://github.com/openclaw/openclaw/pull/205876) remains a draft at 854d3a5a74e31eaa8e13346ed29b3f9ddbd9ca16 requiring real transport proof; preserve its existing authority contract.

No M10 implementation PR or accepted stack parent was established by the bounded refresh. Do not copy sibling results or silently stack on an unaccepted branch.

## Non-goals and PR readiness

Defer cross-platform adapters/APIs, arbitrary external controls, mobile keyboard/handoff work, clipboard-assisted paste/restore, durable delivery state, automatic retry/Undo and semantic/model orchestration.

The owner must settle the control/route, original-selection observability, confirmed postcondition, candidate semantics and preview lifetime before code. Hardware supplied by a user does not supply upstream product acceptance.

**PR readiness: NOT READY.** [The handoff](pr-readiness.md) provides a future narrow title/body, diff boundary and validation sequence. This committed issue draft does not post an issue update, create a PR, request hosted review or close the umbrella.
