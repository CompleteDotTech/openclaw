# M10 requirement dispositions

**Document response complete; native proposal PLAN ONLY; acceptance NEEDS MAINTAINER; runtime proof NOT COLLECTED.**

This iteration follows the user's instruction to commit requested work without comments. It retains M10's live decision-before-implementation gate. A documentation commit is not a human owner decision.

## Sources and freshness

- Current [M10 review](https://github.com/openclaw/openclaw/issues/205846#issuecomment-7186467107): marker item=205846, reviewed_at 2026-11-26T08:33:33.349Z, implementation sha=na, source commit fa9fa2c5436150645fbfbb887e0722b71db0cbec, digest f652baf716247264397875828745ad330da3255b26f893bfd6ac5f102c91a294.
- Current source/guidance: [30daf88b038a5b5ca4eec818fff38bab1543b393](https://github.com/openclaw/openclaw/tree/30daf88b038a5b5ca4eec818fff38bab1543b393).
- Historical inputs: IMPLEMENTATION_PROMPT(2).md, ISSUE(2).md and PR(2).md; later design worker Pasted markdown(1).md, including A1–A4/L1–L5/G1–G5. The earlier local copies are absent; this new revision uses their visible conversation contents, not a claimed byte-perfect restoration.
- Current issue/PR states, exact markers, reviewed heads and inventory limits: [source-refresh.json](checks/source-refresh.json).

The source digest is not a Git commit, and issue updated_at is not acceptance. The historical design package used b6a0808d1235b5eb340ac47841f2e5af2e8b1e17 and a non-atomic refresh around 09:25:50–09:27 UTC. The subsequent local audit used 52132ceead241270e9db22acb8e1ec21fbe218a6. Those identities remain historical.

## Preserved historical Table 1 row

| ID | Capability | Issue · PR | ClawSweeper verdict | Decision → recommended scope | Changes requested | Flags |
|---|---|---|---|---|---|---|
| M10 | Active-application insertion | Issue [#205846](https://github.com/openclaw/openclaw/issues/205846)<br>**No PR** | **Issue:** needs work. Keep open for a native-owner decision. | Start as a bounded macOS-native capability? Which control and insertion route come first? → Scope one native route: one supported control and an explicit commit outcome through the existing native owner. Keep preview and copy recovery. Defer cross-platform. | • Decide native ownership, the first qualified control and the commit semantics together with P01 (#205853).<br>• Reconcile the generation, persistence and repeated-authorization machinery with the admission-once and minimal-state guidance.<br>• Plan the native qualification. | P01 depends on this contract. No PR yet. |

Historical Table 2 assigned no M10 PR blocker/E2E row. Historical Table 3 assigned no direct M10 parent/dependency row. Do not invent either or borrow sibling proof.

**Live annotation:** M10 remains unaccepted with no mapped implementation PR in the bounded searches. Browser #204107 has since merged at 762aa006f9482f44d7975efe9cef2679d498c885; its earlier open/CI-blocked description is historical. New #205973 is an M11 draft with its own finalization defect and decision/proof gates, not an M10 PR or accepted parent.

## One disposition per required finding

DONE below describes only the completed response document. Each remaining decision/proof limit is explicit.

| ID | Exact requirement source | Committed response | Disposition / remaining gate | Evidence |
| --- | --- | --- | --- | --- |
| A1 | Historical Table 1; M10 review: native owner, first control and commit semantics with P01 | Three options; conditional Quick Chat/TextEdit/direct AX recommendation; exact maintainer question | DONE as proposal; NEEDS MAINTAINER; NOT COLLECTED | [decision brief](decision-brief.md) |
| A2 | Table 1 and M10 review: preview/copy recovery and cross-platform deferral | Retain explicit preview/Copy/Cancel, unsent behavior and named deferrals | DONE; acceptance and real recovery proof pending | [issue body](issue-body.revised.md) |
| A3 | Table 1 and review: generations/persistence/repeated authorization | Admission once; existing target/publication/transport correctness; ephemeral attempted phase; no general ledger/generation service | DONE; implementation PLAN ONLY | [decision brief](decision-brief.md) |
| A4 | Table 1: native qualification | Real signed-app/control, microphone/provider/Gateway and failure scenarios; source-derived future commands | DONE as plan; NEEDS USER; NOT COLLECTED | [runbook](checks/qualification-runbook.md) |
| L1 | Worker section A; M10 review: distinguish current native behavior | Trace own-composer dictation and invocation-time completed-reply paste, with no original-control acknowledgment | DONE as source review; no product certification | [decision brief](decision-brief.md) |
| L2 | Worker B–D; live owner/control/clipboard/outcome requirement | Existing native owner, named control and three outcomes; direct AX versus copy versus disclosed paste alternatives | DONE; NEEDS MAINTAINER | [decision brief](decision-brief.md) |
| L3 | Worker B/C: original target and uncertain effects | Pre-overlay binding, no frontmost substitution, conservative focus retirement, no blind retry/alternate writer | DONE; non-atomic AX correctness remains unqualified | [issue body](issue-body.revised.md) |
| L4 | Coordination: P01/#204107/M11 | Correct #204107 to merged; add separate M11 #205973; preserve P01/M11/P06 boundaries | DONE; no accepted native parent inferred | [refresh](checks/source-refresh.json), [notes](issue-revision-notes.md) |
| L5 | Decision-only gate and native proof | Full revised issue and NOT READY handoff; no native implementation/proof claim | DONE; NEEDS MAINTAINER / NEEDS USER | [readiness](pr-readiness.md) |
| G1 | Worker freshness/marker/formal-review inventory | Current issues/comments, reviewed heads, formal reviews/threads and bounded search limitations recorded | DONE; pagination/search limitations retained | [refresh](checks/source-refresh.json) |
| G2 | Exact nine deliverables and preservation | Newly authored nine-file revision in scoped branch; earlier missing files explicitly disclosed; no archive | DONE; not byte-perfect recovery of absent originals | [status](status.md) |
| G3 | Current root/scoped guidance and shared owner fallback | Existing native/browser owner boundaries, admission once and mandatory transport/input correctness retained | DONE; shared policy remains unaccepted and unavailable as separate source | [decision brief](decision-brief.md), [refresh](checks/source-refresh.json) |
| G4 | Real-product/accessibility/upgrade runbook | Native focus/selection/permissions/unknown/copy, keyboard/VoiceOver, restart, stable upgrade and conditional UI asset checks | DONE as plan; NOT COLLECTED; latency UNMEASURED | [runbook](checks/qualification-runbook.md) |
| G5 | Earlier no-write design boundary; latest commit instruction | Preserve the historical boundary and disclose prior in-flight effects; current user now authorizes requested commits, still no comments | DONE as explicit authorization/disposition record; no acceptance inferred | [notes](issue-revision-notes.md), [checks](checks/checks-run.md) |

## Historical AC01–AC14

The original ISSUE(2).md lines 73–86 define these criteria. None is marked passed by this documentation.

| Criterion | Retained, revised or deferred response | Status |
| --- | --- | --- |
| AC01 | Honest capability/permission states for one control; generic versioned cross-platform negotiation deferred | PLAN ONLY |
| AC02 | Original process/control/selection correctness and no retarget; disclose non-atomic check/write limitation | PLAN ONLY; NOT COLLECTED |
| AC03 | One consumed native-owner attempt and observed edit; no duplicate dispatch or distributed exactly-once promise | PLAN ONLY |
| AC04 | Unknown/partial/lost-response outcomes never auto-retry, switch route or replay at restart | PLAN ONLY |
| AC05 | No Enter/send/submit/execution; terminal/newline-executing controls outside qualified route | PLAN ONLY |
| AC06 | Proposed first macOS AX/control qualification, no whole-value replacement | NEEDS MAINTAINER; NOT COLLECTED |
| AC07 | Windows UIA/TSF/UIPI/elevated/secure qualification deferred | DEFERRED — NEEDS MAINTAINER |
| AC08 | X11/XWayland/Wayland/compositor/portal routes deferred without claiming platform support | DEFERRED — NEEDS MAINTAINER |
| AC09 | Android selected-IME/InputConnection and device qualification deferred | DEFERRED — NEEDS MAINTAINER |
| AC10 | iOS keyboard/microphone/handoff and physical-host qualification deferred | DEFERRED — NEEDS MAINTAINER |
| AC11 | Clipboard-assisted snapshot/restore/format contract deferred; explicit Copy is not restoration proof | DEFERRED — NEEDS MAINTAINER |
| AC12 | Existing lifecycle/capture/target checks, consumed attempt, honest cancellation and no restart replay | PLAN ONLY |
| AC13 | Actual native keyboard/VoiceOver/contrast/large-text/RTL/composition recovery | PLAN ONLY; NOT COLLECTED |
| AC14 | Content-free diagnostics, memory-only candidate, preserved current composer/default behavior | PLAN ONLY; NOT COLLECTED |

## Other original asks and hard constraints

| Source / ask | Disposition and evidence |
| --- | --- |
| Original implementation prompt: full implementation, publish and cleanup | Superseded by the design boundary, then latest commit authorization for requested work. This iteration commits the requested decision package; native code still awaits acceptance. No new PR/comment or cleanup of unrelated work |
| Six parent package documents | IMPLEMENTATION_WORKFLOW, ARCHITECTURE, STACKING_PLAN, VALIDATION_PLAN, COVERAGE_MATRIX and DEPENDENCY_SUMMARIES were unavailable; their contents are not invented |
| Original issue/PR: generic capabilities, opaque tokens, expiry, generations, coordinator and receipt persistence | Deferred from first slice; concrete existing-owner target/candidate/attempt state only |
| Original clipboard rich/delayed formats and concurrent restoration | Deferred; direct AX does not use clipboard, explicit Copy discloses overwrite/history and never restores |
| Default settings, kill switches, protocol versions and migrations | No new persistent policy/protocol in this proposal; later actual state changes need an accepted owner and upgrade contract |
| P06 and independence from particular refiner/capture UI | Retained explicitly; no mode router, agent invocation or invented dependency URL |
| Shared preparation policy and bounds | Supplied fallback remains proposal; no new native consumer, model runner, content store or claimed server-sync exclusion |
| Existing transport P02 prerequisite | Preserve assertCurrent, credential dispatch, frame authority, Stop and publication; do not equate feature consent with transport authority |
| Real native proof and safe source execution | Plan only; actual signed identity, provider/mic/Gateway/control evidence; no untrusted source execution or synthetic product qualification |
| Privacy/redaction/credentials | Only public source identities and sanitized status are committed; no raw review dumps, credentials, private endpoints or product logs |
| Keyboard/accessibility/upgrade/latency | Required runbook, all unrun results NOT COLLECTED; 2 KiB p95 target UNMEASURED |
| Output and archive restrictions | Scoped new revision; no ZIP or attachment upload; absent earlier files disclosed rather than silently overwritten/reconstructed as exact |
| Current comments prohibition | No issue/PR comment, reply, reaction, review request or bot command |

This mapping closes documentation work only. The native-owner decision remains the prerequisite to native implementation; actual native evidence remains required before calling the route qualified or PR-ready.
