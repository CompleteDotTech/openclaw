// proof/206273/dictation-proof.mjs
// scenario.json uses the JSON-valid \u000a; JavaScript uses \x0a.
// Syntax checked; the live proof has not been run.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const key = process.env.OPENAI_API_KEY?.trim();
delete process.env.OPENAI_API_KEY;
assert.ok(key, "Set OPENAI_API_KEY only in the live proof step");
assert.ok(process.argv[2], "Usage: node dictation-proof.mjs <built checkout>");
assert.equal(process.platform, "linux");
assert.equal((await statfs("/dev/shm")).type, 0x01021994, "Expected Linux tmpfs");
assert.equal((await readFile("/proc/swaps", "utf8")).trim().split("\x0a").length, 1, "Disable swap first");

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = resolve(process.argv[2]);
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
assert.equal(head, "16883b085acd2af51ca1c36362a917da2d1b8ffc", "Unexpected proof checkout");
const { cases, takes, definitions, applyDraft } = JSON.parse(await readFile(join(here, "scenario.json"), "utf8"));
const require = createRequire(join(repo, "ui/package.json"));
const { createServer: vite } = await import(pathToFileURL(require.resolve("vite")).href);
const { chromium } = require("playwright");
const ui = join(repo, "dist/control-ui");
const asset = (await readFile(join(ui, "index.html"), "utf8")).match(/\bassets\/(index-[\w-]+\.js)\b/)?.[1];
assert.ok(asset, "Expected a built Control UI entry asset");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const assetHash = hash(await readFile(join(ui, "assets", asset)));
const redact = (text) => String(text).replaceAll(key, "[redacted]")
  .replace(/\b(?:Bearer|Basic)\s+[^\s"',;<>]+/gi, "[redacted authorization]")
  .replace(/\bsk-[\w-]{8,}\b/gi, "[redacted key]");
const parse = (buf) => { try { return JSON.parse(buf.toString()); } catch { return {}; } };
const save = (path, value) => writeFile(path, JSON.stringify(value,
  (_, v) => typeof v === "string" ? redact(v) : v, 2) + "\x0a", { mode: 0o600 });
const people = ["operator", "mention"].map((role) => `${role}-${randomUUID()}@proof.example.test`);
const mentionName = "Sage Proof";
const model = "openai/gpt-5.4-mini";
const submit = new Set(["chat.send", "chat.steer", "chat.steerNow", "sessions.send", "sessions.steer", "agent", "agent.start"]);
class AlertError extends Error {}
class TranscriptMismatch extends Error {}

async function until(fn, label, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const result = await fn();
    if (result) return result;
    await sleep(75);
  }
  throw new Error("Timed out: " + label);
}

async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((ok, fail) => server.close((e) => e ? fail(e) : ok()));
  return port;
}

// Test inputs use supported RPCs on an authenticated browser connection.
// No profile rows, preferences, or provider replies are forged.
async function wire(page, origin, trace, holdA = false) {
  const pending = new Map(), appRequests = new Map(), captures = [];
  const started = Date.now();
  const log = (entry) => { const row = { atMs: Date.now() - started, ...entry }; trace.push(row); return row; };
  let ready, releaseA;
  await page.routeWebSocket((url) => url.host === new URL(origin).host, (client) => {
    const server = client.connectToServer();
    ready = undefined;
    client.onMessage((buf) => {
      const f = parse(buf), p = f.params ?? {};
      if (f.type !== "req") return server.send(buf);
      if (submit.has(f.method)) { log({ kind: "blocked-send", method: f.method, id: f.id }); return; }
      if (f.method === "talk.session.create") {
        const cap = { slot: captures.length, valid: p.mode === "transcription" && p.transport === "gateway-relay" && p.brain === "none" };
        captures.push(cap);
        appRequests.set(f.id, { method: f.method, cap });
        log({ kind: "request", method: f.method, id: f.id, slot: cap.slot, mode: p.mode, transport: p.transport, brain: p.brain });
      } else if (f.method === "talk.session.appendAudio") {
        const cap = captures.find((x) => x.id === p.sessionId);
        if (cap && !cap.audio) cap.audio = log({ kind: "first-audio", slot: cap.slot, id: f.id });
      } else if (f.method === "talk.session.close") {
        const cap = captures.find((x) => x.id === p.sessionId);
        appRequests.set(f.id, { method: f.method, cap });
        log({ kind: "request", method: f.method, id: f.id, slot: cap?.slot, discard: p.discard === true });
        if (holdA && cap?.slot === 0 && !p.discard) {
          log({ kind: "hold-close-A", id: f.id });
          releaseA = () => { holdA = false; log({ kind: "release-close-A", id: f.id }); server.send(buf); };
          return;
        }
      } else if (["users.prefs.get", "users.prefs.set", "users.mentionable"].includes(f.method)) {
        appRequests.set(f.id, { method: f.method });
        log({ kind: "request", id: f.id, method: f.method, catalog: (p.keys ?? Object.keys(p.entries ?? {})).includes("dictation.snippets") });
      }
      server.send(buf);
    });
    server.onMessage((buf) => {
      const f = parse(buf), p = f.payload ?? {};
      if (f.type === "res" && pending.has(f.id)) { pending.get(f.id)(f); return; }
      if (f.type === "res" && p.type === "hello-ok") ready = server;
      if (f.type === "res" && appRequests.has(f.id)) {
        const { method, cap } = appRequests.get(f.id);
        appRequests.delete(f.id);
        const row = log({ kind: "response", method, id: f.id, slot: cap?.slot, ok: f.ok, status: p.status, provider: p.provider, message: f.error?.message });
        if (method === "talk.session.create") Object.assign(cap, { opened: true, ok: f.ok, id: p.sessionId, transcriptId: p.transcriptionSessionId ?? p.sessionId, provider: p.provider });
        if (method === "talk.session.close" && cap) cap.closed = row;
      }
      if (f.type === "event" && f.event === "talk.event" && (p.final || p.type === "close" || p.type === "error")) {
        const cap = captures.find((x) => x.transcriptId && x.transcriptId === p.transcriptionSessionId);
        if (cap) log({ kind: "talk.event", slot: cap.slot, sessionId: p.transcriptionSessionId, type: p.type, final: p.final, text: p.text, reason: p.reason, message: p.message, eventId: p.talkEvent?.id, turnId: p.talkEvent?.turnId, seq: p.talkEvent?.seq });
      }
      client.send(buf);
    });
  });
  return {
    captures, log, release: () => releaseA,
    async rpc(method, params) {
      const socket = await until(() => ready, "authenticated Gateway WebSocket", 30000);
      const id = randomUUID();
      const result = Promise.withResolvers();
      pending.set(id, result.resolve);
      const timer = setTimeout(() => result.reject(new Error(method + " timed out")), 15000);
      socket.send(JSON.stringify({ type: "req", id, method, params }));
      try {
        const f = await result.promise;
        log({ kind: "fixture-response", id, method, ok: f.ok, message: f.error?.message });
        assert.equal(f.ok, true, method + ": " + (f.error?.message ?? "rejected"));
        return f.payload;
      } finally { clearTimeout(timer); pending.delete(id); }
    },
  };
}

async function installMic(page) {
  // Synthetic media source only: the app owns resampling, encoding and relay.
  await page.addInitScript(() => {
    const devices = navigator.mediaDevices;
    const real = devices.getUserMedia.bind(devices);
    let next;
    window.proofMic = { arm: (wav) => { next = wav; } };
    devices.getUserMedia = async (options) => {
      if (!next || !options?.audio || options.video) return real(options);
      const wav = next;
      next = undefined;
      const ctx = new AudioContext();
      const source = ctx.createBufferSource();
      const dest = ctx.createMediaStreamDestination();
      source.buffer = await ctx.decodeAudioData(Uint8Array.from(atob(wav), (ch) => ch.charCodeAt(0)).buffer);
      source.connect(dest);
      const track = dest.stream.getAudioTracks()[0];
      const stop = track.stop.bind(track);
      track.stop = () => { stop(); void ctx.close().catch(() => {}); };
      window.proofMic.play = async () => {
        await ctx.resume();
        source.start();
        return 1000 * source.buffer.duration;
      };
      return dest.stream;
    };
  });
}

async function runTake(browser, origin, mentionId, root, c, take) {
  const dir = join(root, c.id, take.id);
  await mkdir(dir, { recursive: true });
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await context.grantPermissions(["microphone"], { origin });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const btn = (name, scope = page) => scope.getByRole("button", { name, exact: true });
  const dialog = (name) => page.getByRole("dialog", { name, exact: true });
  const draft = page.locator('.agent-chat__composer-shell textarea[aria-label="Chat composer"]');
  const rich = page.locator('[data-composer-editor="true"][aria-label="Chat composer"]');
  const review = dialog("Review dictation snippets"), catalog = dialog("Voice snippets");
  const preview = review.getByLabel("Complete dictation preview", { exact: true });
  const trace = [], notes = [], seenAlerts = new Set();
  let status = "FAIL", phase = "set up chat", error, before, after, finalDraft, offReads;
  const readAlerts = async () => (await page.locator('[role="alert"]:visible,[aria-live="assertive"]:visible').allInnerTexts()).map((s) => s.trim()).filter(Boolean);
  const snapshot = () => draft.evaluate((el) => ({ value: el.value, mentions: JSON.parse(el.dataset.composerMentions ?? "[]"), start: el.selectionStart, end: el.selectionEnd, editable: !el.readOnly && !el.disabled }), undefined, { timeout: 1500 });

  async function clearOfAlerts() {
    const alerts = await readAlerts();
    alerts.forEach((s) => seenAlerts.add(s));
    if (alerts.length) throw new AlertError(alerts.join(" | "));
  }

  async function visible(locator, label) {
    return until(async () => {
      await clearOfAlerts();
      return locator.isVisible();
    }, label);
  }

  async function shot(name) {
    const alerts = await readAlerts();
    alerts.forEach((s) => seenAlerts.add(s));
    notes.push({ name, visibleAlerts: alerts, visibleStatus: await page.locator('[role="status"]:visible,.agent-chat__dictation-status:visible').allInnerTexts() });
    await page.screenshot({ path: join(dir, name + ".png"), fullPage: true, timeout: 5000 });
    return alerts;
  }

  try {
    const gw = await wire(page, origin, trace, c.mode === "ordered");
    await installMic(page);
    const id = "proof-" + randomUUID() + "-take";
    const sessionKey = "agent:main:" + id;
    await page.goto(origin + "/");
    await gw.rpc("sessions.create", { agentId: "main", key: sessionKey, label: c.id });
    const assetResponse = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/assets/" + asset));
    await page.goto(origin + "/chat/main/" + id);
    assert.equal(hash(await (await assetResponse).body()), assetHash);
    await until(async () => (await snapshot().catch(() => null))?.editable, "editable composer");
    assert.equal((await snapshot()).value, "");
    const assertEmptyHistory = async () => {
      const result = await gw.rpc("chat.history", { sessionKey, limit: 10 });
      assert.deepEqual(result.messages, []);
    };
    await assertEmptyHistory();

    phase = "save the synthetic catalog through the UI";
    await visible(btn("Voice snippets"), "Voice snippets button");
    await btn("Voice snippets").click();
    const enabled = catalog.getByRole("checkbox", { name: "Enable voice snippets", exact: true });
    await visible(enabled, "Enable voice snippets checkbox");
    const on = c.mode !== "off";
    if ((await enabled.isChecked()) !== on) await enabled.click();
    await until(async () => (await enabled.isChecked()) === on, "saved enable flag");
    if (on) for (const d of definitions) {
      const listed = catalog.getByText(d.name, { exact: true });
      if (await listed.isVisible()) continue;
      await btn("New snippet", catalog).click();
      await catalog.getByLabel("Name", { exact: true }).fill(d.name);
      await catalog.getByLabel("Triggers, one per line", { exact: true }).fill(d.triggers.join("\x0a"));
      await catalog.getByLabel("Exact text", { exact: true }).fill(d.body);
      await btn("Save snippet", catalog).click();
      await visible(listed, "saved definition " + d.name);
    }
    await btn("Close", catalog.locator("openclaw-modal-actions.oc-dialog__footer")).click();
    await catalog.waitFor({ state: "hidden" });

    if (c.mode === "apply") {
      phase = "select a real mention";
      await draft.click();
      await page.keyboard.type("@Sage");
      const item = page.getByRole("listbox", { name: "Mention a person" }).getByRole("option").filter({ hasText: mentionName });
      await visible(item, "synthetic mention recipient");
      await item.click();
      await visible(rich, "mention editor");
      await rich.press("End");
      await page.keyboard.type(applyDraft.text);
      for (let i = 0; i < applyDraft.suffix.length; i++) await rich.press("ArrowLeft");
      for (let i = 0; i < applyDraft.selection.length; i++) await rich.press("Shift+ArrowLeft");
    }
    before = await snapshot();
    if (c.mode === "apply") {
      assert.equal(before.mentions.length, 1);
      assert.equal(before.mentions[0].profileId, mentionId);
      assert.equal(before.value.slice(before.start, before.end), applyDraft.selection);
    }
    await shot("before");
    const captureTraceStart = trace.length;

    async function capture(slot, clipCase) {
      phase = "record " + clipCase;
      const wav = await readFile(join(here, "clips", clipCase + "--" + take.id + ".wav"));
      await page.evaluate((b64) => window.proofMic.arm(b64), wav.toString("base64"));
      const mic = btn("Start voice input");
      await visible(mic, "Start voice input");
      await mic.hover();
      await page.mouse.down();
      try { await visible(page.locator(".agent-chat__dictation-phase--listening"), "listening control"); }
      finally { await page.mouse.up(); }
      const cap = await until(() => gw.captures[slot]?.opened && gw.captures[slot], "Talk session admitted");
      assert.ok(cap.valid && cap.ok && cap.id && cap.transcriptId);
      assert.equal(cap.provider, "openai");
      gw.log({ kind: "clip", slot, clipCase, sha256: hash(wav) });
      await until(() => cap.audio, "first real audio request");
      await sleep(await page.evaluate(() => window.proofMic.play()) + 150);
      const stop = c.mode === "send" ? page.locator(".chat-send-btn--dictation-commit") : btn("Stop and keep text");
      await visible(stop, "stop or finish-for-Send control");
      await stop.click();
      return cap;
    }

    async function transcript(cap, def) {
      phase = "qualify provider final for " + def.name;
      await until(async () => { await clearOfAlerts(); return cap.closed; }, "Gateway close response", 45000);
      assert.equal(cap.closed.ok, true);
      const events = () => trace.filter((r) => r.kind === "talk.event" && r.slot === cap.slot);
      await until(() => events().some((e) => e.type === "close" || e.type === "error"), "Gateway terminal event", 45000);
      assert.ok(events().some((e) => e.type === "close" && e.reason === "completed"));
      assert.ok(!events().some((e) => e.type === "error"));
      const raw = events().filter((e) => e.type === "transcript" && e.final && typeof e.text === "string").map((e) => e.text.trim()).filter(Boolean).join(" ");
      if (!def.triggers.some((t) => raw.toLowerCase() === "insert snippet " + t)) throw new TranscriptMismatch("ASR final did not match a saved alias");
      return raw;
    }

    async function verifyReview(raw, body, name) {
      phase = "review " + name;
      await visible(review, "Review dictation snippets dialog");
      const alerts = await shot(name);
      if (alerts.length) throw new AlertError(alerts.join(" | "));
      assert.equal(await review.getByLabel(/Original transcript/).inputValue(), raw);
      assert.equal(await preview.inputValue(), body);
      const state = await snapshot();
      assert.equal(state.value, before.value);
      assert.deepEqual(state.mentions, before.mentions);
    }

    const a = await capture(0, c.id);
    let applyBody;
    if (c.mode === "ordered") {
      const release = await until(gw.release, "A stopped with close request at the relay boundary");
      const b = await capture(1, "second-capture");
      assert.notEqual(a.transcriptId, b.transcriptId);
      const rawB = await transcript(b, definitions[1]);
      phase = "B settled before A's close is forwarded";
      assert.ok(!trace.some((r) => r.kind === "talk.event" && r.slot === 0 && r.type === "close"));
      assert.equal(await review.isVisible(), false, "B overtook A");
      await shot("b-settled-a-held");
      release();
      await verifyReview(await transcript(a, definitions[0]), definitions[0].body, "review-a");
      await btn("Cancel", review).click();
      await until(async () => await preview.isVisible() && (await preview.inputValue()) === definitions[1].body, "B review after cancelling A");
      await verifyReview(rawB, definitions[1].body, "review-b");
      applyBody = definitions[1].body;
    } else {
      const raw = await transcript(a, definitions[0]);
      if (c.mode === "off") {
        phase = "disabled snippets leave editable prose";
        await until(async () => { const state = await snapshot(); return state.editable && state.value === raw; }, "editable ordinary prose");
        assert.equal(await review.isVisible(), false);
        offReads = trace.slice(captureTraceStart).filter((r) => r.method === "users.prefs.get" && r.catalog).length;
      } else {
        applyBody = definitions[0].body;
        await verifyReview(raw, applyBody, "review");
      }
    }
    if (applyBody !== undefined) {
      phase = "Apply one exact edit";
      const apply = btn("Add to draft", review);
      await visible(apply, "Add to draft button");
      await apply.click();
      await review.waitFor({ state: "hidden" });
      after = await snapshot();
      assert.equal(after.value, before.value.slice(0, before.start) + applyBody + before.value.slice(before.end));
      assert.deepEqual(after.mentions, before.mentions);
      assert.equal(after.start, before.start + applyBody.length);
      assert.equal(after.end, after.start);
      assert.equal(after.editable, true);
      await shot("applied");
      if (c.mode === "apply") {
        phase = "one keyboard Undo";
        await rich.press("Control+z");
        await until(async () => (await snapshot()).value === before.value, "original draft restored");
        assert.deepEqual((await snapshot()).mentions, before.mentions);
      }
    }
    phase = "verify nothing was submitted";
    await assertEmptyHistory();
    assert.ok(!trace.some((r) => r.kind === "blocked-send"));
    status = "PASS";
  } catch (e) {
    status = e instanceof AlertError ? "ERROR" : e instanceof TranscriptMismatch ? "INCONCLUSIVE_STT" : "FAIL";
    error = e.message;
  } finally {
    try {
      const alerts = await shot("final");
      if (alerts.length) { status = "ERROR"; error = alerts.join(" | "); }
    } catch (e) { status = "ERROR"; error ??= e.message; }
    if (trace.some((r) => r.kind === "blocked-send") && status !== "ERROR") {
      status = "FAIL"; error = "Unexpected submission attempt (blocked before reaching Gateway)";
    }
    finalDraft = await snapshot().catch(() => null);
    await save(join(dir, "take.json"), { head, case: c.id, take: take.id, phase, status, error, asset, assetHash,
      timing: c.mode === "ordered" ? "A close request delayed; no Gateway event modified" : "unaltered",
      offReads, offReadContract: c.mode === "off" ? "decision pending" : undefined,
      before, after, finalDraft, visibleAlerts: [...seenAlerts], notes, gatewayEvents: trace });
    await context.close();
  }
  return { id: take.id, status, artifact: take.id + "/take.json" };
}

const ram = await mkdtemp("/dev/shm/openclaw-proof-");
const proxies = [];
let browser, gateway, exited;
const originalTmp = process.env.TMPDIR;
try {
  process.env.TMPDIR = ram;
  const port = await freePort();
  const local = "http://127.0.0.1:" + port;
  const origins = [];
  for (const [i, person] of people.entries()) {
    const proxy = await vite({ configFile: false, envFile: false, root: ram, appType: "custom", logLevel: "error",
      server: { host: "127.0.0.1", port: 0, hmr: false, proxy: { "/": { target: local, ws: true,
        headers: { "x-forwarded-for": "192.0.2." + (10 + i), "x-forwarded-proto": "http", "x-forwarded-user": person } } } } });
    proxies.push(proxy);
    await proxy.listen();
    const { port: proxyPort } = proxy.httpServer.address();
    origins.push("http://127.0.0.1:" + proxyPort);
  }
  const config = join(ram, "openclaw.json"), workspace = join(ram, "workspace");
  await mkdir(workspace);
  const scopes = ["operator.read", "operator.write", "operator.approvals", "operator.questions"];
  await save(config, {
    gateway: { mode: "local", bind: "loopback", port, trustedProxies: ["127.0.0.1", "::1"],
      controlUi: { enabled: true, root: ui, allowedOrigins: origins },
      auth: { mode: "trusted-proxy", identityScopes: { [people[0]]: ["operator.admin"] },
        trustedProxy: { allowLoopback: true, userHeader: "x-forwarded-user", requiredHeaders: ["x-forwarded-proto"],
          allowUsers: people, deviceAutoApprove: { enabled: true, scopes } } } },
    cron: { enabled: false },
    agents: { defaults: { workspace, heartbeat: { every: "0m" }, model: { primary: model }, models: { [model]: {} }, voiceModel: "openai/gpt-4o-transcribe" } },
    plugins: { entries: { openai: { enabled: true } } },
  });
  const env = { PATH: process.env.PATH, HOME: ram, TMPDIR: ram, TMP: ram, TEMP: ram, LANG: "C.UTF-8", NODE_DISABLE_COMPILE_CACHE: "1",
    XDG_CACHE_HOME: join(ram, "xdg-cache"), XDG_CONFIG_HOME: join(ram, "xdg-config"),
    XDG_DATA_HOME: join(ram, "xdg-data"), XDG_STATE_HOME: join(ram, "xdg-state"),
    OPENCLAW_HOME: ram, OPENCLAW_STATE_DIR: join(ram, "state"), OPENCLAW_CONFIG_PATH: config, OPENCLAW_SKIP_CHANNELS: "1" };
  gateway = spawn(process.execPath, [join(repo, "openclaw.mjs"), "gateway", "run", "--bind", "loopback"],
    { cwd: repo, env: { ...env, OPENAI_API_KEY: key }, detached: true, stdio: "ignore" });
  let spawnError;
  gateway.on("error", (e) => { spawnError = e; });
  exited = once(gateway, "close").catch(() => undefined);
  await until(async () => {
    if (spawnError || gateway.exitCode !== null || gateway.signalCode !== null) throw new Error("Gateway exited before readiness");
    return (await fetch(local + "/readyz", { signal: AbortSignal.timeout(1500) }).catch(() => null))?.ok;
  }, "isolated Gateway ready", 180000);
  browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"], env: { ...env } });
  await mkdir(join(here, "results"), { recursive: true });
  const root = await mkdtemp(join(here, "results", "run-"));
  const profiles = [];
  for (const [i, origin] of origins.entries()) {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage(), trace = [];
    try {
      const gw = await wire(page, origin, trace);
      await page.goto(origin + "/");
      const { profile } = await gw.rpc("users.self", {});
      assert.ok(profile.id);
      const displayName = i === 0 ? "Dictation Proof Operator" : mentionName;
      const updated = await gw.rpc("users.setDisplayName", { profileId: profile.id, displayName });
      assert.equal(updated.profile.displayName, displayName);
      profiles.push(profile.id);
    } catch (e) {
      const alerts = await page.getByRole("alert").filter({ visible: true }).allInnerTexts().catch(() => []);
      await page.screenshot({ path: join(root, "profile-" + i + "-error.png"), fullPage: true, timeout: 5000 }).catch(() => {});
      await save(join(root, "profile-" + i + "-error.json"), { status: "ERROR", error: alerts.join(" | ") || e.message, visibleAlerts: alerts, gatewayEvents: trace });
      throw e;
    } finally { await context.close(); }
  }
  assert.notEqual(profiles[0], profiles[1]);
  for (const c of cases.filter((item) => item.mode !== "clip-only")) {
    const results = [];
    for (const take of takes) results.push(await runTake(browser, origins[0], profiles[1], root, c, take));
    const status = ["ERROR", "FAIL"].find((s) => results.some((r) => r.status === s)) ??
      (results.some((r) => r.status === "PASS") ? "PASS" : "INCONCLUSIVE_STT");
    const detail = results.map((r) => r.id + ": " + r.status).join("; ");
    await save(join(root, c.id, "case.json"), { head, status, detail, takes: results });
    console.log(c.id + ": " + status + " — " + detail);
    if (status !== "PASS") process.exitCode = 1;
  }
} catch (e) {
  console.error(redact(e.message));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await Promise.allSettled(proxies.map((proxy) => proxy.close()));
  if (gateway?.pid && gateway.exitCode === null && gateway.signalCode === null) {
    try { process.kill(-gateway.pid, "SIGTERM"); } catch {}
    await Promise.race([exited, sleep(5000, undefined, { ref: false })]);
    if (gateway.exitCode === null && gateway.signalCode === null) {
      try { process.kill(-gateway.pid, "SIGKILL"); } catch {}
      await exited;
    }
  }
  if (originalTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmp;
  await rm(ram, { recursive: true, force: true });
}
