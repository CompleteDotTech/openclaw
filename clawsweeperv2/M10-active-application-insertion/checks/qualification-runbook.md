# M10 native qualification runbook

**Plan only. Native implementation acceptance: NEEDS MAINTAINER. Hardware/access: NEEDS USER / approved environment. Every runtime result: NOT COLLECTED. Latency: UNMEASURED.**

No command in this future runbook was run for the documentation commit. No empty proof files, simulated native screenshots, benchmark values or replacement runtime logs are supplied.

## 1. Accepted scope and prerequisites

Proposed tuple: macOS 27.2.1; one TextEdit plain-text document; its original main editing control; one direct Accessibility selected-text replacement. The actual Mac/OS build, TextEdit version, AX role/readability/writability, selection/overlay behavior and postcondition remain NOT COLLECTED.

Before code or execution:

1. Obtain native-owner/P01 acceptance of Quick Chat ownership, entrypoint, target capture before overlay, original-placement/acknowledgment contract, candidate finality wording and recovery-preview lifetime.
2. Establish permitted secretless source isolation. A checkout/worktree or temporary home is not isolation. Credentialed product execution needs the repository-required trusted approval after source review.
3. Obtain a physical Mac, microphone, real Apple Speech/capture route, real task-owned Gateway, permitted signer and actual native user session. Do not use operator state or credentials in tests.
4. Use a stable signed app identity for permission proof. Record actual bundle identity, designated requirement and installation context without exposing signer credentials/private values.
5. Refresh current main, applicable guidance, package/toolchain pins and latest stable OpenClaw/OS versions at execution time. A proposed OS name is not a compatibility certificate.

The current source audited for this plan is [30daf88b038a5b5ca4eec818fff38bab1543b393](https://github.com/openclaw/openclaw/tree/30daf88b038a5b5ca4eec818fff38bab1543b393). A later implementation records its own full base/head. No new M10 PR, comments, review request, workflow approval or rerun is authorized by this plan.

## 2. Behavior to decide before implementing

Use QuickChatController/QuickChatModel and current QuickChatDictation/SpeechCaptureResources/PermissionManager. Freeze the latest recognized candidate for explicit user approval; ordinary Stop cancels recognition, so no new provider-final drain is promised.

Bind the original app instance/window/control and minimal selection/placement evidence before overlay focus. Preserve concrete request/capture/input/target correctness; do not substitute the current frontmost application. Foreign focus, changed selection or invalid original control retires insertion eligibility; return-to-old-target does not revive it.

The existing panel dismisses on outside interaction. The native owner must decide a bounded new-workflow recovery lifetime so failure does not discard the candidate. Ordinary composer/paste/dismissal behavior retains its existing meaning.

Feature policy is admitted once. Keep explicit cancellation, OS enforcement and existing transport assertCurrent/credential-dispatch/inbound-frame/transcript-publication guards, including authorized Stop. Do not invent a new consent generation, delivery journal or persistent target store.

AX check, write and read-back are not atomic. Accept a route only if the named control can provide safe original-selection behavior and privacy-bounded evidence of the expected edit. Wrong-target/selection writes block release. Whole-value setters, hidden activation/selection reset, synthetic keys and alternate insertion methods are excluded.

| Outcome | Required observation |
| --- | --- |
| Confirmed | Approved text is observed at the original location in the same control through the accepted postcondition, with supported adjacent content and unsent behavior preserved |
| Failed before effect | The mutating setter was never invoked |
| Unknown / possibly applied | Setter dispatch occurred, but the effect/read-back cannot be established, including a returned error, timeout, target loss or post-dispatch cancellation |

Consume the attempt before dispatch. No automatic retry, alternate route or rollback after unknown. Restart discards memory and replays nothing; a lost preview is not claimed recoverable history.

Direct AX insertion does not touch the clipboard. Explicit Copy replaces current contents and may persist in clipboard history. It does not paste, restore formats, erase history or guarantee external Undo. Warn of possible duplication after unknown insertion; never restore over a later user copy.

## 3. Future commands: source-derived, NOT RUN

Run only in a later accepted and appropriately isolated task. Current [native guide](https://github.com/openclaw/openclaw/blob/30daf88b038a5b5ca4eec818fff38bab1543b393/apps/macos/AGENTS.md) and [testing policy](https://github.com/openclaw/openclaw/blob/30daf88b038a5b5ca4eec818fff38bab1543b393/.agents/skills/openclaw-testing/SKILL.md) own these commands. No actual changed-lane selection exists for an unimplemented feature.

### Select the actual diff and native toolchain

    xcodebuild -version
    xcrun swift --version
    pnpm changed:lanes --json

The planner must run against the accepted implementation files, not this proposal or the old broad local implementation. Record the concrete selected test/type/lint/format commands then. Do not invent a future feature test path or substitute a full-suite run.

### Build and verify native source

    swift build --package-path apps/macos --build-system native --product OpenClaw
    swift build --package-path apps/macos --build-system native --build-tests
    scripts/lint-swift.sh macos
    scripts/format-swift.sh macos
    pnpm native:i18n:verify

The format script currently invokes swiftformat --lint. If the accepted implementation adds native copy, generate its inventory through pnpm native:i18n:baseline before verification; do not hand-edit generated inventories or translations.

After a matching test build, inside the actual permitted disposable macOS CI environment:

    node scripts/test-macos-native.mts default --package-path apps/macos --build-system native --skip-build --filter "QuickChatPowerFeaturesTests|QuickChatControllerTests|QuickChatModelTests"

QuickChatPowerFeaturesTests covers current composer/reply/PID logic; it does not qualify external AX behavior. The Controller/Model suites exist in the current tree; exact additional cases/selectors must follow actual accepted changes. Select QuickChatCatalogPresentationTests separately if the accepted rendered preview/focus changes reach it.

Keep test arguments consistent with the build, including --enable-code-coverage when used by the current CI build. The [native launcher](https://github.com/openclaw/openclaw/blob/30daf88b038a5b5ca4eec818fff38bab1543b393/scripts/test-macos-native.mts#L95) requires genuine CI/GitHub Actions/runner context and --skip-build; marker variables are not a sandbox and must not be spoofed to run on an operator desktop. A filtered swift test or temporary HOME is not an approved substitute.

### Signed product and identity

    pnpm mac:package
    codesign -dr - dist/OpenClaw.app

Packaging executes source/build dependencies and needs prior source-trust approval. Development defaults to ai.openclaw.mac.debug; it is not release-upgrade permission continuity. The current documented release-identity packaging command is:

    BUILD_CONFIG=release BUNDLE_ID=ai.openclaw.mac ./scripts/package-mac-app.sh

It requires the proper signer, clean source and release prerequisites. A bundle ID alone does not establish the designated requirement. Do not overwrite an operator app, reset its TCC state or use host-global restart/cleanup scripts to manufacture proof. [Native setup/signing](https://github.com/openclaw/openclaw/blob/30daf88b038a5b5ca4eec818fff38bab1543b393/docs/platforms/mac/dev-setup.md#L159)

### Conditional browser coordination lane

Only if a later accepted change actually touches the browser owner, verify the current path and planner selection:

    pnpm test ui/src/pages/chat/composer-dictation.test.ts --maxWorkers=1

Prepared-checkout wrapper:

    node scripts/run-vitest.mjs ui/src/pages/chat/composer-dictation.test.ts --maxWorkers=1

Use canonical wrappers, not bare Vitest. Serialize processes or assign each its own OPENCLAW_VITEST_FS_MODULE_CACHE_PATH. Matching TypeScript/lint configs must come from the accepted diff's actual selection, not placeholders reported as passed.

For claimed real Control UI proof:

    pnpm ui:build

Record the resulting dist/control-ui asset identity and verify the real task-owned Gateway actually serves the changed asset before exercising it with a real provider/microphone. Browser fixture results or successful builds do not qualify native TextEdit insertion.

## 4. Real product setup

Use a dedicated permitted account and benign TextEdit document in plain-text mode. Record actual OS/build, TextEdit version, original main control/AX role and required attributes without dumping the full AX tree or unrelated text. Prepare a short harmless fixture such as North red South, select red, and speak a benign replacement.

Run the actual signed-app flow: **admit original target → capture through physical microphone → Stop → inspect/freeze candidate → explicit Insert → observe original control and reported outcome**. Record the actual recognized candidate; do not pretend ASR returned an imagined expected value. Use a real task-owned Gateway and existing real Speech path. Keep credentials in their existing owner and out of command arguments, captures and output files.

Capture enough before/preview/after context to tie the original control and explicit action to the observed edit. A screenshot of text somewhere, API success, matching PID, synthetic control or parent browser media is insufficient.

## 5. Native scenario matrix

Every row is **NOT COLLECTED**. Expectations are proposed gates, not results. Evidence stems name future files only; create no empty artifacts.

| ID | Real action / condition | Required observation | Evidence stem |
| --- | --- | --- | --- |
| N01 | Caret insertion after real capture/review | Approved text at original caret with accepted read-back, no added hidden transformation or submission | N01-caret |
| N02 | Replace original benign selection | Only original selection replaced, supported surrounding text and selection behavior preserved | N02-selection |
| N03 | Operate Quick Chat overlay with pointer/keyboard | Actual original control/selection remains unambiguous through qualified panel behavior, or fail before effect | N03-overlay |
| N04 | Bring another app forward during capture/review, then return | Retire insertion eligibility, preserve recoverable candidate, no retarget or automatic rearm | N04-foreign-focus |
| N05 | Change TextEdit window/control/caret/selection/content | Refuse stale placement without restoring/moving selection or choosing a new control | N05-placement-change |
| N06 | Close target/document or reopen same title | Original target cannot be replaced by same-name/PID assumptions; no setter if original is invalid | N06-closed-target |
| N07 | Deny permissions; revoke before a separate new request | Existing owner/OS enforces denial, no prompt loop or replay after later grant; report actual recovery | N07-permissions |
| N08 | Cancel during permission preparation, capture and review; permit late callback | Existing owner releases capture, no revived eligibility/publication; before-effect cancellation dispatches nothing | N08-cancel |
| N09 | Native-owner-approved real uncertain response/read-back around dispatch | Classify based on whether mutation was invoked; unknown if effect cannot be established; no blind retry/rollback | N09-unknown |
| N10 | Rapid duplicate confirmation/callback | One dispatch/effect; verify document and approved content-free event evidence, not only a disabled button | N10-once |
| N11 | Failure followed by explicit Copy and user paste | Clipboard impact disclosed; no automatic paste/send; possible-duplication warning after unknown | N11-copy |
| N12 | User copies different text during review, then direct insertion | Intervening clipboard survives direct AX. A later explicit Copy intentionally replaces it; no restoration | N12-clipboard |
| N13 | Unsupported/read-only/secure/other control | No hidden setter, whole-value replacement, key injection or activation fallback; recover text where available | N13-unsupported |
| N14 | Current composer dictation and existing reply paste | Existing semantics preserved, and reply-paste behavior is not relabeled original-control acknowledgment | N14-regression |
| N15 | Restart task-owned app before dispatch and after an uncertain attempt | No replay; prior in-memory preview may be lost; inspect possible earlier effect without claiming rollback/durable receipt | N15-restart |

If a safe real N09 condition cannot be produced, leave it NOT COLLECTED and explain the gap. A mocked timeout tests a unit contract only; do not ship a speculative persistent service/fault injector just to obtain media. Never exercise destructive terminal commands to prove absence of execution.

## 6. Accessibility and text matrix

Every row is **NOT COLLECTED**, using the same actual signed app and qualified control.

| ID | Mode | Required observation |
| --- | --- | --- |
| A01 | Keyboard only | Reach trigger/Stop/preview/Insert/Copy/Cancel, visible focus, Escape behavior, no accidental Return/send or duplicate key-repeat effect |
| A02 | VoiceOver | Destination, candidate, unavailable state, clipboard impact and one honest final outcome are understandable; focus does not retarget |
| A03 | Contrast/reduced transparency/motion | Controls and outcome distinctions remain perceivable without color-only cues |
| A04 | Native text/display scaling | Long candidate and recovery controls remain readable/reachable; record actual supported setting |
| A05 | RTL/mixed direction | Correct logical range replacement and read-back, not merely plausible visual appearance |
| A06 | Emoji/combining marks/multiline | Actual native ranges and approved line breaks preserved; current prose helpers do not prove exact external placement |
| A07 | IME/marked composition | No implicit loss/commit of marked text; keep unsupported composition outside the first route if it cannot be distinguished safely |

Host Undo is not promised. If later requested, demonstrate its actual scope using that control's own Undo; no global undo shortcut, document snapshot rollback or fabricated Undo button.

## 7. Latest stable upgrade

**NOT COLLECTED.** Verify latest stable OpenClaw version/commit at execution time.

1. Install the verified official stable release in the approved disposable native account; record version/build and signed identity class.
2. Use benign test-owned settings and actual intended permission grants; never copy operator defaults, Keychain, Gateway tokens or private config.
3. Upgrade through the native owner's approved path to the accepted candidate with the required signing identity. A debug bundle or matching bundle ID alone is not release/permission continuity.
4. Observe settings, app location, designated requirement and actual prompts/grants; rerun caret/selection/new-request permission cases.
5. If signer, accepted candidate or stable identity cannot be supplied, stop that lane and record the precise gap.

Planned evidence: U01-stable-upgrade.md, with real source/stable identities and before/after observations. No upgrade, identity reset, signing bypass or global cleanup occurred in this iteration.

## 8. Measurement and evidence hygiene

The historical proposed target is 2 KiB plain text, p95 ≤150 ms from final local commit authorization to confirmed edit, excluding review, refinement and dialogs. **UNMEASURED**; adopt only through the owner decision. Report named hardware, sample count, cold/warm distributions and actual timing method. Failures/refusals/unknowns are separate, never fast successes. Any wrong-target write blocks release.

Future evidence files, created only when actually collected:

| File | Contents | Current status |
| --- | --- | --- |
| run-manifest.json | Full base/head/toolchain, actual OS/TextEdit/app identity/control, approved environment, UTC and actual artifact inventory | NOT COLLECTED |
| command-results.md | Commands actually run, times, exit/outcome and evidence paths; planned commands separate | NOT COLLECTED |
| native-build.sanitized.log / native-tests.sanitized.log | Real matching native build/test output | NOT COLLECTED |
| N01-caret-before.png / preview.png / after.png / recording | Actual original-control/user-action sequence; use relevant stems for other cases | NOT COLLECTED |
| scenario-observations.md | Per-case actual effects, uncertainty, target/selection, recovery and evidence | NOT COLLECTED |
| accessibility-observations.md / U01-stable-upgrade.md | Actual assistive/text and stable-upgrade observations | NOT COLLECTED |
| latency-observations.md | Only actual required measurements and methodology | UNMEASURED |

Use benign speech/documents in the real product. Redact IPs, tokens/keys, phone numbers, emails, private endpoints/titles/paths and unrelated windows before saving. Do not dump clipboard/history, AX trees, environment or credentials. If a credential-like value is incidentally encountered, refer only to its source file:line and type, flag possible rotation for the user and do not rotate it. No secret scan is authorized by this runbook.

The route qualifies only after its owner accepts the bounded contract and actual source/product evidence supports it. If minimal read-back or original placement fails, keep copy recovery and leave automatic insertion unavailable.
