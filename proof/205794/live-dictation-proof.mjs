import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const here = dirname(script);
const stt = "gpt-4o-transcribe";
const chat = "openai/gpt-5.4-mini";
const seed = "Existing draft:";
const blockedMethods = new Set(["chat.send", "chat.inject", "sessions.send", "agent", "send"]);
const relayMethods = new Set(["talk.session.create", "talk.session.appendAudio", "talk.session.close"]);
const words = (s) => (s.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
const save = (p, data) => writeFile(p, JSON.stringify(data, null, 2) + "
");
let apiKey;

function scrub(value) {
  let s = String(value ?? "");
  if (apiKey) s = s.replaceAll(apiKey, "[redacted]");
  return s.replace(/\b(?:sk-|gh[pousr]_|github_pat_)[\w-]{12,}/gi, "[redacted]")
    .replace(/\b(?:bearer|basic)\s+[\w.+/=:-]+/gi, "[redacted]")
    .replace(/\b(token|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, "$1$2[redacted]");
}

function diagnostic(step, error) {
  return { step, name: scrub(error?.name ?? "Error"), message: scrub(error?.message ?? error).slice(0, 1600) };
}

async function waitFor(check, message, ms = 20_000) {
  const end = Date.now() + ms;
  do {
    if (await check()) return;
    await sleep(75);
  } while (Date.now() < end);
  throw new Error(message);
}

const errorNodes = [
  '[role="alert"]', '[role="alertdialog"]', '[aria-live="assertive"]',
  '.app-toast--error', '.agent-chat__composer-status[data-tone="danger"]',
].join(", ");

class VisibleUiError extends Error {
  name = "VisibleUiError";
}

async function errorEntries(page) {
  if (!page) return [];
  return page.locator(errorNodes).filter({ visible: true }).evaluateAll((els) =>
    els.filter((el) => !el.closest(".sr-only") && el.checkVisibility({ opacityProperty: true }))
      .map((el) => ({
        text: el.innerText?.trim() ?? "",
        composerLazyAlert: el.matches('.lazy-view-error--inline[role="alert"]') &&
          !!el.closest(".agent-chat__composer-shell"),
      })).filter(({ text }) => text),
  );
}

async function errorText(page) {
  return (await errorEntries(page)).map(({ text }) => text);
}

export async function visibleErrors(page) {
  return [...new Set((await errorText(page)).map(scrub))];
}

async function loopbackPort() {
  const s = createServer();
  await new Promise((ok, fail) => { s.once("error", fail); s.listen(0, "127.0.0.1", ok); });
  const { port } = s.address();
  await new Promise((ok, fail) => s.close((err) => err ? fail(err) : ok()));
  return port;
}

async function clipMs(path) {
  const b = await readFile(path);
  assert.equal(b.toString("ascii", 0, 4), "RIFF");
  assert.equal(b.toString("ascii", 8, 12), "WAVE");
  let pcm = false, bytes = 0;
  for (let i = 12; i + 8 <= b.length;) {
    const tag = b.toString("ascii", i, i + 4), n = b.readUInt32LE(i + 4), p = i + 8;
    assert.ok(p + n <= b.length, "Truncated WAV");
    if (tag === "fmt ") {
      assert.ok(n >= 16);
      assert.equal(b.readUInt16LE(p), 1, "Expected PCM");
      assert.equal(b.readUInt16LE(p + 2), 1, "Expected mono");
      assert.equal(b.readUInt32LE(p + 4), 48000, "Expected 48 kHz");
      assert.equal(b.readUInt16LE(p + 14), 16, "Expected PCM16");
      pcm = true;
    }
    if (tag === "data") bytes += n;
    i = p + n + n % 2;
  }
  assert.ok(pcm && bytes && bytes % 2 === 0, "Missing/invalid PCM data");
  return Math.ceil(bytes / 96);
}

export async function installGuard(page, origin) {
  const wire = { hello: false, audioBytes: 0, final: [], blocked: [], ready: false,
    closeAck: false, stopRequested: false, events: [] };
  const record = (kind, type, f, p, extra = {}) => {
    const talk = p?.talkEvent;
    const text = p?.text ?? talk?.payload?.text;
    wire.events.push({ kind, type: scrub(type), relayType: kind === "event" ? scrub(p?.type) || null : null,
      final: talk?.final ?? p?.final ?? null, relayFinal: p?.final ?? null,
      seq: talk?.seq ?? f.seq ?? null, gatewaySeq: f.seq ?? null,
      textLength: typeof text === "string" ? text.length : 0,
      stopPhase: wire.stopRequested ? "after-stop" : "before-stop", ...extra });
  };
  const wsOrigin = origin.replace(/^http/, "ws");
  const parse = (message) => { try { return JSON.parse(message.toString()); } catch { return null; } };
  await page.routeWebSocket((url) => url.origin === wsOrigin, (client) => {
    const server = client.connectToServer();
    const pending = new Map();
    let sessionId;
    client.onMessage((message) => {
      const f = parse(message);
      if (blockedMethods.has(f?.method)) {
        wire.blocked.push(f.method);
        return; // Never forward, and do not fake success.
      }
      if (relayMethods.has(f?.method)) {
        pending.set(f.id, f.method);
        if (f.method === "talk.session.close") record("request", f.method, f, null);
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const f = parse(message), p = f?.payload;
      if (f?.event === "connect.challenge") record("event", f.event, f, null);
      if (p?.type === "hello-ok") {
        record("response", "hello-ok", f, null);
        wire.hello = true;
      }
      if (f?.type === "res" && pending.has(f.id)) {
        const method = pending.get(f.id);
        pending.delete(f.id);
        record("response", method, f, null, { ok: f.ok === true });
        if (!f.ok) wire.fault ??= method + " rejected";
        else if (method === "talk.session.create") {
          sessionId = p?.transcriptionSessionId ?? p?.sessionId;
          wire.provider = p?.provider;
          wire.mode = p?.mode;
          wire.transport = p?.transport;
        } else if (method === "talk.session.close") wire.closeAck = true;
      }
      if (f?.event === "talk.event" && sessionId && p?.transcriptionSessionId === sessionId) {
        record("event", p.talkEvent?.type ?? p.type, f, p);
        if (p.type === "ready") wire.ready = true;
        if (p.type === "inputAudio") wire.audioBytes += Number(p.byteLength) || 0;
        if (p.type === "error") wire.fault ??= "Transcription relay emitted an error";
        if (p.type === "close") wire.closeReason = p.reason;
        if (p.type === "transcript" && p.final === true && typeof p.text === "string" && p.text.trim()) {
          wire.final.push(p.text.trim());
        }
      }
      client.send(message);
    });
  });
  return wire;
}

export async function capture(page, path) {
  const text = await page.locator("body").innerText({ timeout: 3000 });
  const values = await page.locator("input, textarea").evaluateAll((els) => els.map((e) => e.value));
  // Never mask the UI. If a possible credential is visible, withhold the whole image.
  if ([text, ...values, ...await errorText(page)].some((s) => scrub(s) !== s)) {
    throw new Error("Screenshot withheld: possible credential");
  }
  await page.screenshot({ path, animations: "disabled", timeout: 5000 });
}

export async function runTake(c, take, { chromium, origin, results, commit, reviewChunkPath }) {
  const id = take ? c.id + "--" + take.id : c.id;
  const out = join(results, id);
  await mkdir(out);
  const e = c.expected;
  const shouldReview = e.action !== "insert";
  const expectsRecovery = e.blockReviewChunk === true;
  const intended = c.segments.map((s) => s.text).join(" ");
  const state = { caseId: c.id, takeId: take?.id ?? null, commit, stt, expected: e, status: "BLOCKED", step: "clip" };
  let browser, page, draft, review, wire, setup;
  state.visibleErrors = [];
  const seen = new Set();
  const observeErrors = async (includeExpected = false) => {
    const errors = new Set();
    for (const entry of await errorEntries(page).catch(() => [])) {
      const text = scrub(entry.text);
      const expected = entry.composerLazyAlert &&
        state.reviewChunk?.aborts.some((item) => item.stopPhase === "after-stop");
      if (includeExpected || !expected) errors.add(text);
      const stopPhase = wire?.stopRequested ? "after-stop" : "before-stop";
      const key = JSON.stringify([state.step, stopPhase, text, Boolean(expected)]);
      if (!seen.has(key)) {
        seen.add(key);
        state.visibleErrors.push({ step: state.step, stopPhase, text, expected: Boolean(expected) });
      }
    }
    return [...errors];
  };
  const waitUi = (check, message, ms) => waitFor(async () => {
    const ready = await check();
    const errors = await observeErrors();
    if (errors.length && (expectsRecovery || !ready)) throw new VisibleUiError(errors.join("
"));
    return ready;
  }, message, ms);
  try {
    const clip = join(here, "clips", id + ".wav");
    state.clipMs = await clipMs(clip);
    state.step = "browser-connect";
    browser = await chromium.launch({ channel: "chromium", headless: true, args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--use-file-for-fake-audio-capture=" + clip + "%noloop",
    ] });
    const ctx = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 1000 },
      ...(expectsRecovery ? { serviceWorkers: "block" } : {}) });
    await ctx.grantPermissions(["microphone"], { origin });
    page = await ctx.newPage();
    page.setDefaultTimeout(10_000);
    wire = await installGuard(page, origin);
    if (expectsRecovery) {
      state.step = "arm-review-chunk-fault";
      assert.ok(e.mode === "explicit" && !e.literal && ["keep", "cancel"].includes(e.action));
      assert.ok(reviewChunkPath, "Full review chunk not identified");
      const fault = state.reviewChunk = { path: reviewChunkPath, aborts: [], failures: [] };
      const target = (url) => url.origin === origin && url.pathname === reviewChunkPath;
      const stopPhase = () => wire.stopRequested ? "after-stop" : "before-stop";
      page.on("requestfailed", (request) => {
        if (target(new URL(request.url()))) {
          fault.failures.push({ stopPhase: stopPhase(), error: scrub(request.failure()?.errorText) });
        }
      });
      await page.route(target, async (route) => {
        fault.aborts.push({ stopPhase: stopPhase(), resourceType: route.request().resourceType() });
        await route.abort("failed");
      });
    }
    await page.goto(origin + "/chat", { waitUntil: "domcontentloaded" });
    await waitUi(() => wire.hello, "Gateway hello-ok not observed", 60_000);

    state.step = "composer-model-ready";
    const shell = page.locator(".agent-chat__composer-shell:visible").filter({
      has: page.locator('textarea[aria-label="Chat composer"]:visible'),
    }).last();
    draft = shell.locator('textarea[aria-label="Chat composer"]:visible');
    setup = page.getByText("Set up a model", { exact: true }).filter({ visible: true });
    await waitUi(async () => await setup.count() === 0 && await draft.isVisible() &&
      await draft.isEnabled({ timeout: 1000 }) && await draft.isEditable({ timeout: 1000 }),
      "Model setup did not clear or the composer stayed disabled", 45_000);

    state.step = "prepare-composer";
    const policy = shell.getByRole("combobox", { name: "Spoken corrections", exact: true });
    if (e.mode === "explicit") await policy.selectOption("explicit");
    assert.equal(await policy.inputValue(), e.mode, "Unexpected correction policy");
    if (e.literal) await shell.getByRole("checkbox", { name: "Literal for this recording" }).check();
    await draft.fill(seed);
    await draft.press("End");

    state.step = "capture";
    const button = (name) => shell.getByRole("button", { name, exact: true }).filter({ visible: true }).last();
    const start = button("Start voice input"), stop = button("Stop and keep text");
    await start.hover();
    await page.mouse.down();
    try { await waitUi(() => stop.isVisible(), "Recording never exposed Stop and keep text"); }
    finally { await page.mouse.up(); }
    const finishAt = Date.now() + state.clipMs + 250;
    await waitUi(() => Date.now() >= finishAt, "Clip playback did not finish", state.clipMs + 3000);
    wire.stopRequested = true; // Receipt phase is relative to issuing the Stop click.
    await stop.click();

    state.step = "openai-finalization";
    let faultAt;
    await waitUi(() => {
      if (!wire.fault) return wire.closeReason && wire.closeAck;
      faultAt ??= Date.now();
      return Date.now() - faultAt >= 1000; // Give a rejected relay time to render its alert.
    }, "No terminal relay receipt", 30_000);
    assert.ok(!wire.fault, wire.fault);
    assert.equal(wire.provider, "openai");
    assert.equal(wire.mode, "transcription");
    assert.equal(wire.transport, "gateway-relay");
    assert.ok(wire.ready && wire.audioBytes >= 8000, "No ready OpenAI relay with captured audio");
    assert.equal(wire.closeReason, "completed");

    const original = wire.final.join(" ");
    state.intendedWordsMatched = words(original) === words(intended);
    if (!original) {
      const until = Date.now() + 600;
      await waitUi(() => Date.now() >= until, "Checking empty transcription", 2000);
      const errors = await observeErrors();
      if (errors.length) throw new VisibleUiError(errors.join("
"));
      state.status = "INCONCLUSIVE_STT";
    } else {
      state.status = "FAIL"; // Grade the app against what the provider actually returned.
      review = shell.getByRole("region", { name: "Review dictated text", exact: true });
      if (shouldReview) {
        state.step = expectsRecovery ? "review-download-recovery" : "original-only-review";
        const recovery = review.and(shell.locator(".composer-correction-recovery"));
        const loadAlert = shell.locator('.lazy-view-error--inline[role="alert"]:visible');
        if (expectsRecovery) {
          await waitUi(async () => state.reviewChunk.failures.length > 0 &&
            await recovery.isVisible() && await loadAlert.count() === 1,
          "Failed full-review request did not show an inline alert and the recovery panel");
          assert.ok(state.reviewChunk.aborts.length > 0 &&
            state.reviewChunk.aborts.every((item) => item.stopPhase === "after-stop"),
          "Review chunk was not requested exclusively after Stop");
          state.reviewChunk.alertText = scrub(await loadAlert.innerText());
          assert.ok(state.reviewChunk.alertText, "Expected a visible review-load message");
        } else {
          await waitUi(() => review.isVisible(), "Original-only review did not appear");
        }
        assert.equal(await draft.inputValue(), seed, "Review changed the unsent draft before a choice");
        const panel = expectsRecovery ? recovery : review;
        const recognized = panel.getByRole(expectsRecovery ? "textbox" : "region",
          { name: "Original recognized text", exact: true });
        if (expectsRecovery) {
          assert.ok(await recognized.isVisible(), "Recovery transcript is not visible");
          assert.equal(await recognized.inputValue(), original, "Recovery rewrote the returned text");
          assert.equal(await recognized.isEditable(), false, "Recovery transcript is not read-only");
          assert.equal(await panel.getByRole("button", { name: "Accept correction", exact: true }).count(), 0);
        } else {
          assert.equal((await recognized.textContent())?.trim(), original, "Review rewrote the returned text");
          assert.ok(await panel.getByRole("button", { name: "Accept correction", exact: true }).isDisabled());
        }
        await capture(page, join(out, expectsRecovery ? "recovery.png" : "review.png"));
        state.step = "keyboard-choice";
        const choice = panel.getByRole("button", { name: e.action === "keep" ? "Keep original" : "Cancel", exact: true });
        assert.ok(await choice.isEnabled(), "Expected review choice to be enabled");
        await choice.press("Enter");
      }
      state.step = "final-draft";
      const suffix = (/^[,.;:!?)]/.test(original) ? "" : " ") + original;
      const expectedDraft = e.action === "cancel" ? seed : seed + suffix;
      await waitUi(async () => await draft.isVisible() && await draft.inputValue() === expectedDraft,
        "Final draft did not match the expected unsent text");
      await waitUi(() => start.isVisible(), "The idle microphone control did not return");
      await waitUi(async () => !await review.isVisible(), "Review did not close or was unexpected");
      assert.equal(await draft.inputValue(), expectedDraft, "Draft changed after the recording settled");
      if (e.literal) {
        assert.equal(await shell.getByRole("checkbox", { name: "Literal for this recording" }).isChecked(), false);
      }
      // Recovery is graded against nonempty provider output, not the TTS prompt.
      state.status = expectsRecovery || state.intendedWordsMatched ? "PASS" : "INCONCLUSIVE_STT";
      state.step = "complete";
    }
  } catch (error) {
    // If the recovery panel never appeared, surface the actual alert rather than a timeout.
    const recoveryMissing = state.step === "review-download-recovery" &&
      !await page.locator(".composer-correction-recovery").isVisible().catch(() => false);
    const errors = await observeErrors(recoveryMissing);
    if (state.step === "composer-model-ready" && await setup?.first().isVisible().catch(() => false)) {
      const text = scrub(await setup.first().innerText({ timeout: 1000 }).catch(() => "Set up a model"));
      errors.push(text);
      state.visibleErrors.push({ step: state.step, stopPhase: "before-stop", text });
    }
    if (error instanceof VisibleUiError || errors.length) {
      state.status = "ERROR";
      state.error = { step: state.step, name: "VisibleUiError",
        message: error instanceof VisibleUiError ? error.message : errors.join("
") };
    } else state.error = diagnostic(state.step, error);
  } finally {
    try {
      state.visibleErrorsAtEnd = await observeErrors(true);
      state.finalDraft = await draft?.inputValue({ timeout: 2000 }).then(scrub).catch(() => null) ?? null;
      state.reviewVisible = await review?.isVisible().catch(() => null) ?? null;
      if (page) {
        try { await capture(page, join(out, "final.png")); }
        catch (error) {
          state.screenshotError = diagnostic("final-screenshot", error);
          if (state.status === "PASS" || state.status === "INCONCLUSIVE_STT") state.status = "BLOCKED";
        }
      }
      await browser?.close();
    } finally {
      state.gateway = wire ? { provider: wire.provider === "openai" ? "openai" : null,
        audioBytes: wire.audioBytes, ready: wire.ready, closeAck: wire.closeAck,
        cleanClose: wire.closeReason === "completed", blockedSendAttempts: wire.blocked, events: wire.events } : null;
      if (wire?.blocked.length) {
        state.status = "FAIL";
        state.error = diagnostic("no-send", new Error("Blocked unexpected RPC: " + wire.blocked.join(", ")));
      }
      await save(join(out, "transcript.json"), { intended, finalSegments: (wire?.final ?? []).map(scrub),
        finalTranscript: scrub((wire?.final ?? []).join(" ")) });
      await save(join(out, "final-state.json"), state);
    }
  }
  return { id, status: state.status, ...(state.error ? { error: state.error } : {}) };
}

async function main() {
  apiKey = process.env.OPENAI_API_KEY?.trim();
  delete process.env.OPENAI_API_KEY; // Playwright and Git do not inherit it.
  assert.ok(apiKey && process.argv.length === 3 && process.platform === "linux",
    "On Linux, set OPENAI_API_KEY and run node live-dictation-proof.mjs <built-pr-checkout>");
  const root = resolve(process.argv[2]);
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(JSON.parse(await readFile(join(root, "dist", "build-info.json"), "utf8")).commit, commit);
  const ui = join(root, "dist", "control-ui");
  await access(join(ui, "index.html"));
  const { chromium } = createRequire(join(root, "ui", "package.json"))("playwright");
  const scenario = JSON.parse(await readFile(join(here, "scenario.json"), "utf8"));
  let reviewChunkPath;
  if (scenario.cases.some((c) => c.expected.blockReviewChunk === true)) {
    const names = (await readdir(join(ui, "assets")))
      .filter((name) => /^composer-correction-review-[A-Za-z0-9_-]+\.js$/.test(name));
    assert.equal(names.length, 1, "Expected exactly one built full-review JS chunk; found " + names.join(", "));
    reviewChunkPath = "/assets/" + names[0];
  }
  assert.equal(scenario.leadingSilenceMs, 500);
  const checkIds = (items) => {
    assert.ok(items.length && items.every(({ id }) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)));
    assert.equal(new Set(items.map(({ id }) => id)).size, items.length);
  };
  checkIds(scenario.cases);
  if (scenario.takes?.length) checkIds(scenario.takes);
  const takes = scenario.takes?.length ? scenario.takes : [null];
  const output = join(here, "results");
  await mkdir(output, { recursive: true });
  const results = await mkdtemp(join(output, "run-"));
  const scratch = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "dictation-proof-"));
  let gateway, closed;
  try {
    const port = await loopbackPort(), origin = "http://127.0.0.1:" + port;
    const config = join(scratch, "openclaw.json");
    await save(config, {
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "none" }, controlUi: { enabled: true, root: ui } },
      agents: { defaults: { workspace: join(scratch, "workspace"), model: { primary: chat }, models: { [chat]: {} },
        voiceModel: "openai/" + stt } },
      plugins: { allow: ["openai"], entries: { openai: { enabled: true } } },
      logging: { level: "silent", consoleLevel: "silent", file: join(scratch, "gateway.log") },
    });
    gateway = spawn(process.execPath, [join(root, "openclaw.mjs"), "gateway", "run"], {
      cwd: scratch, detached: true, stdio: "ignore",
      env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, OPENCLAW_HOME: scratch,
        OPENCLAW_STATE_DIR: join(scratch, "state"), OPENCLAW_CONFIG_PATH: config, OPENAI_API_KEY: apiKey },
    });
    let stopped = false;
    closed = new Promise((done) => {
      gateway.once("error", () => { stopped = true; done(); });
      gateway.once("close", () => { stopped = true; done(); });
    });
    await waitFor(async () => {
      if (stopped) throw new Error("Gateway exited before readiness");
      try { return (await fetch(origin + "/readyz", { signal: AbortSignal.timeout(1200) })).ok; }
      catch { return false; }
    }, "Gateway /readyz did not become ready", 120_000);

    const cases = [];
    for (const c of scenario.cases) {
      const runs = [];
      for (const take of takes) {
        const result = await runTake(c, take, { chromium, origin, results, commit, reviewChunkPath });
        runs.push(result);
        const message = result.status === "ERROR" ? " — " + result.error.message.replace(/\s+/g, " ") : "";
        console.log(result.id + ": " + result.status + message);
      }
      const status = ["FAIL", "ERROR", "BLOCKED", "PASS"].find((s) => runs.some((r) => r.status === s)) ?? "INCONCLUSIVE_STT";
      cases.push({ id: c.id, status, runs });
    }
    await save(join(results, "summary.json"), { commit, stt, cases });
    console.log("Artifacts: " + results);
    process.exitCode = cases.some((c) => ["FAIL", "ERROR", "BLOCKED"].includes(c.status)) ? 1
      : cases.some((c) => c.status === "INCONCLUSIVE_STT") ? 2 : 0;
  } catch (error) {
    await save(join(results, "harness-error.json"), diagnostic("gateway-or-harness", error));
    throw error;
  } finally {
    if (gateway?.pid) {
      const signal = (name) => {
        try { process.kill(-gateway.pid, name); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      };
      signal("SIGTERM");
      if (!(await Promise.race([closed.then(() => true), sleep(5000, false, { ref: false })]))) {
        signal("SIGKILL");
        await closed;
      }
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

if (resolve(process.argv[1] ?? "") === script) {
  await main().catch((error) => {
    console.error(JSON.stringify(diagnostic("harness", error)));
    process.exitCode = 1;
  });
}
