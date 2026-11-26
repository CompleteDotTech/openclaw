# M10 PR-readiness handoff

## NOT READY

**This is a committed proposal, not a native implementation PR. Owner acceptance: NEEDS MAINTAINER. Product proof: NOT COLLECTED.**

The latest user authorized commits requested by ClawSweeper and prohibited comments. M10's current review still requires the native-owner/control/outcome decision before implementation and carries no-new-fix-PR guidance. Do not turn this commit into a new PR, comment, review request or claim of accepted scope.

## Current related state

| Item | Observed state | Relevance |
| --- | --- | --- |
| [M10 #205846](https://github.com/openclaw/openclaw/issues/205846) | Open; one unchanged automated review; sha=na; no observed human acceptance or mapped implementation PR | Native-owner/control/outcome decision required |
| [P01 #205853](https://github.com/openclaw/openclaw/issues/205853) | Open, unaccepted native workflow/control decision | First proposed shortcut/review consumer |
| [M11 #205845](https://github.com/openclaw/openclaw/issues/205845) | Open, unaccepted refinement-owner/admission decision | Candidate producer later; no separate paste owner |
| [#204107](https://github.com/openclaw/openclaw/pull/204107) | Merged 2026-11-26T12:52:40Z; merge 762aa006f9482f44d7975efe9cef2679d498c885 | Landed browser lifecycle work; old open/unmerged/CI review prose is historical, not native acceptance |
| [M11 #205973](https://github.com/openclaw/openclaw/pull/205973) | Open draft, head 7dab77ee268617d70ab5f035bb7864cc278aa327 | Separate 2500 ms finalization timeout / 5000 ms relay-drain finding, owner decision and real proof remain; do not treat as M10 parent |
| [P02 #205876](https://github.com/openclaw/openclaw/pull/205876) | Open draft, head 854d3a5a74e31eaa8e13346ed29b3f9ddbd9ca16 | Existing transport-authority repair; production proof pending |

Full bases, heads, timestamps, markers, returned formal review/thread counts and limitations are in [source-refresh.json](checks/source-refresh.json). Zero returned threads is not a proven exhaustive GraphQL traversal. The existing local implementation reported earlier is not recovered or republished by this proposal.

## Exact prerequisites

1. **NEEDS MAINTAINER:** native owner/P01 acceptance of Quick Chat ownership, first consumer, one named TextEdit/OS/control tuple and direct AX operation.
2. **NEEDS MAINTAINER:** original selection/focus/overlay contract, privacy-bounded confirmed postcondition, non-atomic race limitations, latest-recognition review semantics and recovery-preview lifetime.
3. **NEEDS MAINTAINER:** ephemeral state, no new public API/persistent policy, no clipboard insertion/restoration and explicit scope deferrals.
4. **NEEDS USER / approved environment:** permitted Mac/microphone/real Speech route/task-owned Gateway, correct signer and actual permission identity. Source execution needs permitted secretless isolation or the repository-required trusted approval.
5. **PLAN ONLY:** refresh actual source/toolchain/stable release, implement only the accepted native slice, run matching checks and real qualification, obtain independent review.

Complete documents or a user's hardware/commit authorization do not supply upstream acceptance. No branch from a sibling draft is an accepted parent by implication.

## Proposed future PR

**Title:** feat(macos): insert reviewed dictation into a qualified TextEdit control

This is a planning body in the current four-section template; replace it with actual implemented behavior, source commits and results when an accepted and qualified change is prepared for publication. Related: #205846, without a closing keyword while broad criteria remain deferred.

### What Problem This Solves

Quick Chat composer dictation and invocation-time reply paste do not guarantee one approved edit into the original external control/selection. A future accepted native slice would provide that behavior for one qualified TextEdit plain-text control with explicit observed/failed/unknown outcomes.

### User Impact

Users would review a frozen recognized candidate, explicitly insert it into the original supported control once, or recover it through Copy/Cancel when the route is unavailable. Unknown effects would require inspection and never trigger automatic retry or another writer. No Enter, send, submit, hidden activation or universal support is promised.

### Why This Change Was Made

The proposal keeps capture, native permissions, presentation and effects in the existing Quick Chat owners. It adds no public coordinator, second capture queue, persistent delivery history or repeated feature-consent service. Existing transport and target/publication correctness remain mandatory. The direct route leaves clipboard contents alone; explicit Copy discloses replacement/history.

### Evidence

Owner acceptance NEEDS MAINTAINER. Implementation PLAN ONLY. Native proof NOT COLLECTED. Latency UNMEASURED. A later PR must cite the real decision, base/head, accepted support tuple, source check results, signed-app/control before/after evidence, selection/focus/permission/unknown/accessibility recovery, and stable-upgrade observations. Sibling browser fixtures and this documentation check are not native qualification.

## Proposed diff boundary

| Existing owner/path | Accepted future purpose | Boundary |
| --- | --- | --- |
| QuickChatController.swift | Bind target before overlay, own one attempt/outcome, preserve this workflow's recovery preview | No second queue/service or generic focus/permission manager |
| QuickChatModel.swift / QuickChatView.swift | Explicit destination, candidate, Insert/Copy/Cancel/outcome | Preserve ordinary composer/send/reply-paste semantics |
| QuickChatDictation / SpeechCaptureResources | Reuse capture/Stop and latest-recognized candidate | No assumed provider-final drain or new audio pipeline |
| PermissionManager and existing lifecycle/activation surfaces | Existing OS prompts and actual target correctness | No consent generations, bypass or hidden activation |
| Existing QuickChatPowerFeaturesTests / Controller / Model / rendered suites | Meaningful accepted owner-boundary cases | Exact test selectors only after actual changes; unit mocks do not certify AX |
| docs/platforms/mac/webchat.md and generated native string inventory if changed | Actual supported behavior/refusals and accessible copy | Canonical generators only; no unrelated translations/release notes |

A local AX helper is optional only if justified by the accepted native boundary. Do not prescribe a new API/helper/test path before implementation. Exclude web/iOS/Android code, public SDK/Gateway interfaces, new settings/schema/durability, clipboard restoration, semantic/model orchestration and unrelated fixes. P06 keeps mode choice; no specific refiner or P01 UI is required.

## Future implementation/verification sequence

1. Record the real owner/P01 decision and accepted issue scope.
2. Establish permitted source isolation and native test/product environments; a linked worktree alone is not isolation and CI markers must not be spoofed.
3. Refresh main/guidance/dependencies and stable versions; choose the actual base. Do not carry the old broad unpublished implementation or sibling draft wholesale.
4. Run the existing changed-lanes planner only on the actual accepted diff in the permitted environment; record its exact test/type/lint/format selection.
5. Reproduce the actual native gap, implement the bounded existing-owner route, and add focused meaningful tests.
6. Compile app/tests and run the qualified native test/lint/format/localization lanes. No optional broad suite to populate a checklist.
7. Execute [the real qualification runbook](checks/qualification-runbook.md), including exact placement, overlay/foreign focus, permissions, cancellation, unknown/no retry, Copy, keyboard/VoiceOver and stable upgrade.
8. Independently review the real diff and evidence; fix findings and rerun affected checks.
9. No M10 PR is created in this iteration. Any later publication must satisfy the accepted scope and current quota/media/CI/owner rules. No comment/review request is authorized by this user instruction.

If the selected AX control cannot meet original-placement and acknowledgment correctness, keep it unavailable and preserve explicit copy recovery. Do not claim the umbrella complete or treat “unknown” as permission to release a wrong-target write.
