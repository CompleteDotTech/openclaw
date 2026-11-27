import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const here = fileURLToPath(new URL(".", import.meta.url));
const head = "45971d0305bfaf4a7096d14ba7dbfe3e28b18b3a";
const key = process.env.OPENAI_API_KEY?.trim();
delete process.env.OPENAI_API_KEY;
const token = randomBytes(32).toString("hex");
const run = promisify(execFile);
const readJson = async (path) => JSON.parse(await fs.readFile(path, "utf8"));
const writeJson = (path, value) => fs.writeFile(path, JSON.stringify(value, null, 2) + "\n");
const verdict = (statuses) => ["ERROR", "FAIL", "PASS"].find((status) => statuses.includes(status)) ?? "INCONCLUSIVE_STT";
const fail = (message) => { throw new Error(message); };
const words = (s) => s.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
const secrets = new Set([key, token].filter(Boolean));
const sends = new Set(["chat.send", "sessions.send", "sessions.dispatch", "agent"]);
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const alertSelector = '[role="alert"], .callout.danger, .agent-chat__composer-alert, .agent-chat__composer-status[data-tone="danger"]';

class VisibleUiError extends Error { name = "VisibleUiError"; }

const redactCredentials = (s) => [...secrets].reduce((text, secret) => text.replaceAll(secret, "[redacted]"), s)
  .replace(/\bsk-[\w-]+|\bBearer\s+[-\w.]+|\b(?:bootstrapToken|deviceToken|apiKey|token)=[-\w.%]+/gi, "[redacted]");
const safe = (s) => redactCredentials(s)
  .replace(/\b(?:https?|wss?):\/\/\S+|\b(?:\d{1,3}\.){3}\d{1,3}\b|\+?\d[\d ().-]{7,}\d/gi, "[redacted]")
  .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]");

async function waitFor(check, ms, message) {
  const end = Date.now() + ms;
  do {
    if (await check()) return;
    await sleep(20);
  } while (Date.now() < end);
  fail(message);
}

async function freePort() {
  const server = createServer();
  await new Promise((ok, no) => server.once("error", no).listen(0, "127.0.0.1", ok));
  const { port } = server.address();
  await new Promise((ok, no) => server.close((err) => err ? no(err) : ok()));
  return port;
}

async function wavMs(path) {
  const wav = await fs.readFile(path);
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    fail("Expected a RIFF/WAVE clip");
  }
  let pcm = false;
  for (let i = 12; i + 8 <= wav.length;) {
    const id = wav.toString("ascii", i, i + 4);
    const n = wav.readUInt32LE(i + 4);
    const p = i + 8;
    if (p + n > wav.length) break;
    if (id === "fmt " && n >= 16) {
      pcm = wav.readUInt16LE(p) === 1 && wav.readUInt16LE(p + 2) === 1 &&
        wav.readUInt32LE(p + 4) === 48000 && wav.readUInt16LE(p + 14) === 16;
    }
    if (id === "data" && pcm && n > 0 && n % 2 === 0) return n / 96;
    i = p + n + (n % 2);
  }
  fail("Expected 48 kHz mono 16-bit PCM with a data chunk");
}

async function observe(page, origin) {
  const wsOrigin = origin.replace(/^http:/, "ws:");
  const s = { seq: 0, bytes: 0, ready: false, stop: 0, close: 0, ack: false,
    closed: false, error: null, blocked: null, finals: [], events: [] };
  const parse = (message) => {
    try { return JSON.parse(message.toString()); } catch { return null; }
  };
  await page.routeWebSocket((url) => url.origin === wsOrigin, (socket) => {
    const server = socket.connectToServer();
    const appends = new Set();
    let create, session, close;
    socket.onMessage((message) => {
      const f = parse(message);
      if (f?.type === "req") {
        if (sends.has(f.method)) { s.blocked ??= f.method; return; }
        if (f.method === "talk.session.create" && f.params?.mode === "transcription") create = f.id;
        if (session && f.params?.sessionId === session) {
          if (f.method === "talk.session.appendAudio") appends.add(f.id);
          if (f.method === "talk.session.close") {
            if (f.params.discard || !s.stop) s.error ??= "Capture closed without the expected Stop and keep text action";
            close = f.id;
            s.close = ++s.seq;
          }
        }
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const f = parse(message);
      if (f?.type === "res") {
        if (f.payload?.type === "hello-ok") {
          const auth = f.payload.auth;
          for (const value of [auth?.deviceToken, ...(auth?.deviceTokens ?? []).map((t) => t.deviceToken)]) {
            if (typeof value === "string" && value) secrets.add(value);
          }
        }
        if (create && f.id === create) {
          const p = f.payload;
          if (!f.ok || p?.provider !== "openai" || p.transport !== "gateway-relay" ||
              p.audio?.inputSampleRateHz !== 8000 || p.audio?.inputEncoding !== "g711_ulaw" ||
              !p.transcriptionSessionId) {
            s.error ??= f.error?.message ?? "Expected an OpenAI G.711 transcription relay";
          } else session = p.transcriptionSessionId;
        }
        if (appends.delete(f.id) && !f.ok) s.error ??= f.error?.message ?? "Audio append rejected";
        if (close && f.id === close) {
          s.ack = f.ok === true;
          if (!s.ack) s.error ??= f.error?.message ?? "Stop rejected";
        }
      }
      const e = f?.payload;
      if (f?.type === "event" && f.event === "talk.event" && session && e?.transcriptionSessionId === session) {
        const order = ++s.seq;
        const text = typeof e.text === "string" ? e.text : typeof e.message === "string" ? e.message : "";
        s.events.push({
          order, type: e.type, talkType: e.talkEvent?.type ?? null,
          final: e.final ?? e.talkEvent?.final ?? null,
          seq: e.talkEvent?.seq ?? f.seq ?? null, gatewaySeq: f.seq ?? null,
          textLength: text.length,
          ...(e.type === "inputAudio" ? { byteLength: e.byteLength } : {}),
          ...(e.type === "close" ? { reason: e.reason } : {}),
        });
        if (e.type === "ready") s.ready = true;
        if (e.type === "inputAudio" && Number.isSafeInteger(e.byteLength)) s.bytes += e.byteLength;
        if (e.type === "transcript" && e.final === true && typeof e.text === "string" && e.text.trim()) {
          s.finals.push({ order, text: e.text.trim() });
        }
        if (e.type === "error") s.error ??= e.message || "OpenAI transcription relay error";
        if (e.type === "close") {
          if (e.reason === "completed") s.closed = true;
          else s.error ??= "Transcription relay closed with an error";
        }
      }
      socket.send(message);
    });
  });
  return s;
}

function diagnostic(step, error) {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return { step, name: safe(name), message: safe(message).slice(0, 700) };
}

async function pageEvidence(page, path) {
  // Redact value fragments in place after the assertions. Never hide or mask
  // an alert, a status, or any other element just because it reports a failure.
  const snapshot = await page.evaluateHandle(() => {
    const fields = [...document.querySelectorAll("input:not([type=hidden]), textarea")];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let node; (node = walker.nextNode());) {
      if (node.data.trim() && !node.parentElement?.closest("script, style, noscript")) nodes.push(node);
    }
    return { fields, nodes };
  });
  try {
    const values = await snapshot.evaluate(({ fields, nodes }) => [
      fields.map((field) => field.value), nodes.map((node) => node.data),
    ]);
    const changes = values.map((group) => group.flatMap((value, index) => {
      const redacted = redactCredentials(value);
      return value === redacted ? [] : [[index, redacted]];
    }));
    await snapshot.evaluate(({ fields, nodes }, [fieldEdits, textEdits]) => {
      for (const [i, value] of fieldEdits) fields[i].value = value;
      for (const [i, value] of textEdits) nodes[i].data = value;
    }, changes);
    await fs.writeFile(path, await page.screenshot({ fullPage: true, timeout: 5000 }));
  } finally { await snapshot.dispose(); }
}

async function runTake(c, take, { chromium, cli, origin, env, work, output, leadingSilenceMs }) {
  const id = take ? c.id + "--" + take.id : c.id;
  const dir = join(output, id);
  await fs.mkdir(dir, { mode: 0o700 });
  let context, page, textarea, s, error = null, draft = "", relative = null;
  const alerts = new Set();
  const visibleAlerts = async () => {
    if (!page || page.isClosed()) return [];
    const raw = await page.locator(alertSelector).filter({ visible: true }).allInnerTexts().catch(() => []);
    const texts = [...new Set(raw.map((text) => text.trim()).filter(Boolean).map(safe))];
    for (const text of texts) alerts.add(text);
    return texts;
  };
  let listening = false, settled = false, screenshot = false, screenshotError = null, status = "FAIL";
  let step = "validate WAV";
  try {
    const clip = join(here, "clips", id + ".wav");
    const duration = await wavMs(clip);
    const speechEnd = duration - c.segments.at(-1).pauseAfterMs;
    if (speechEnd <= leadingSilenceMs) fail("WAV is shorter than its declared padding");
    const late = c.expected.finalRelativeToStop === "after";
    // G.711 at 8 kHz is 8 bytes/ms. Wait until the relay saw the audio block
    // containing the last word (or the trailing silence for the VAD case).
    const minimumBytes = Math.ceil((late ? speechEnd : duration) * 8);
    step = "launch Chromium";
    context = await chromium.launchPersistentContext(join(work, id), {
      env, locale: "en-US", permissions: ["microphone"], serviceWorkers: "block",
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        "--use-file-for-fake-audio-capture=" + clip + "%noloop"],
    });
    page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(15_000);
    s = await observe(page, origin);
    const until = (check, ms, message, control = false) => waitFor(async () => {
      if (s.blocked) fail("Blocked forbidden send RPC: " + s.blocked);
      const ok = await check();
      const visible = await visibleAlerts();
      if (visible.length && ((control && !ok) || s.error)) throw new VisibleUiError(visible.join(" | "));
      if (s.error) fail(s.error);
      return ok;
    }, ms, message);
    step = "create chat and open Control UI";
    const slug = "proof-" + id.replaceAll("--", "-");
    await cli(["gateway", "call", "sessions.create", "--json", "--params", JSON.stringify({
      key: "agent:main:" + slug, agentId: "main", label: id,
    })]);
    const url = new URL(JSON.parse(await cli(["dashboard", "--json"])).browserUrl);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const bootstrap = fragment.get("bootstrapToken");
    if (bootstrap) secrets.add(bootstrap);
    if (url.origin !== origin || url.username || url.password || !bootstrap ||
        new URL(fragment.get("gatewayUrl")).origin !== origin.replace(/^http:/, "ws:")) {
      fail("Expected the isolated loopback Dashboard handoff");
    }
    await page.addInitScript(() => localStorage.setItem("openclaw:control-ui:community-invite:v2",
      JSON.stringify({ dismissedAtMs: Date.now() })));
    url.pathname = "/chat/main/" + slug;
    url.search = "";
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    const shell = page.locator(".agent-chat__composer-shell");
    textarea = shell.locator('textarea[aria-label="Chat composer"]');
    const setup = page.getByText("Set up a model", { exact: true }).filter({ visible: true });
    const start = shell.getByRole("button", { name: "Start voice input", exact: true });
    const stop = shell.getByRole("button", { name: "Stop and keep text", exact: true });
    const phase = shell.locator(".agent-chat__dictation-status");
    step = "wait for configured and editable composer";
    await until(async () => !(await setup.count()) && await textarea.isVisible() && await textarea.isEditable() &&
      await start.isVisible() && await start.isEnabled(), 30_000, "Model setup did not clear or the composer stayed disabled", true);
    if (await textarea.inputValue()) fail("Expected an empty composer");
    step = "hold microphone and reach Listening";
    await start.hover();
    await page.mouse.down();
    try {
      await until(() => shell.locator(".agent-chat__dictation-phase--listening").isVisible(),
        15_000, "Dictation did not enter Listening", true);
      listening = true;
    } finally { await page.mouse.up(); }
    step = "observe OpenAI readiness and sufficient audio";
    await until(() => s.ready && s.bytes >= minimumBytes, 20_000, "OpenAI readiness or relay audio missing");
    if (!late) {
      step = "observe a final before Stop";
      // Still close on a recognition miss; a successful close is required.
      await waitFor(() => s.blocked || s.error || s.finals.length, 12_000, "VAD wait elapsed").catch(() => {});
    }
    step = "click Stop and observe a clean relay close";
    await until(async () => await stop.isVisible() && await stop.isEnabled(),
      15_000, "Stop and keep text was not available", true);
    await stop.click({ trial: true });
    s.stop = ++s.seq; // Stop action issued; the close RPC has its own later order.
    await stop.click();
    await until(() => s.close && s.ack && s.closed, 20_000, "No acknowledged Stop and completed relay close");
    step = "wait for the final composer state";
    await until(async () => !(await phase.isVisible()) && await start.isVisible(),
      15_000, "Composer did not return to its idle controls", true);
    draft = await textarea.inputValue();
    settled = true;
    step = "qualify final words, ordering, and composer text";
    const expected = words(c.expected.text);
    const joinFinals = (accept) => words(s.finals.filter(accept).map((f) => f.text).join(" "));
    if (s.error) fail(s.error);
    if (joinFinals(() => true) !== expected) status = "INCONCLUSIVE_STT";
    else {
      relative = joinFinals((f) => f.order < s.stop) === expected ? "before"
        : joinFinals((f) => f.order < s.close) !== expected ? "after" : "between-click-and-close";
      if (words(draft) !== expected) fail("The provider returned the words but the settled composer did not preserve them");
      if (relative !== c.expected.finalRelativeToStop) fail("Expected final ordering at Stop was not observed");
      status = "PASS";
    }
  } catch (cause) {
    const visible = await visibleAlerts();
    if (cause instanceof VisibleUiError || (visible.length && !settled)) {
      status = "ERROR";
      error = diagnostic(step, cause instanceof VisibleUiError ? cause : new VisibleUiError(visible.join(" | ")));
    } else error = diagnostic(step, cause);
  } finally {
    await visibleAlerts();
    try {
      if (page && !page.isClosed()) {
        if (status === "ERROR") {
          await page.locator(alertSelector).filter({ visible: true }).first().scrollIntoViewIfNeeded({ timeout: 800 }).catch(() => {});
        }
        await pageEvidence(page, join(dir, "page.png"));
        screenshot = true;
      } else if (!error) fail("No browser page to capture");
    } catch (cause) {
      screenshotError = diagnostic("capture page screenshot", cause);
      error ??= screenshotError;
      if (status !== "ERROR") status = "FAIL";
    }
    await context?.close().catch(() => {});
  }
  if (s?.blocked) {
    status = "FAIL";
    error = diagnostic("guard no-send boundary", new Error("Blocked forbidden send RPC: " + s.blocked));
  }
  await fs.writeFile(join(dir, "transcript.txt"), (s?.finals ?? []).map((f) => safe(f.text)).join("\n") + "\n");
  await writeJson(join(dir, "state.json"), {
    buildCommit: head, caseId: c.id, take: take?.id ?? null, status, error, alerts: [...alerts],
    stopOrder: s?.stop || null, closeRequestOrder: s?.close || null,
    gatewayEvents: (s?.events ?? []).map((event) => ({
      ...event, relativeToStop: !s.stop ? "stop-not-reached" : event.order < s.stop ? "before" : "after",
    })),
    listening, providerReady: !!s?.ready, audioBytes: s?.bytes ?? 0, stopAttempted: !!s?.stop,
    closeRequested: !!s?.close, stopAcknowledged: !!s?.ack, relayClosed: !!s?.closed,
    blockedSend: s?.blocked ?? null, settled, expectedFinalRelativeToStop: c.expected.finalRelativeToStop,
    observedFinalRelativeToStop: relative, composer: safe(draft), screenshot, screenshotError,
  });
  console.log(id + ": " + status + (error ? " — " + error.step : ""));
  return status;
}

async function main() {
  if (!process.argv[2] || !key) fail("Set OPENAI_API_KEY and pass the built PR checkout");
  const repo = resolve(process.argv[2]);
  const dist = join(repo, "dist");
  if ((await readJson(join(dist, "build-info.json"))).commit !== head) fail("Build metadata does not match the PR head");
  await fs.access(join(dist, "control-ui", "index.html"));
  let entry = join(dist, "index.js");
  try { await fs.access(entry); } catch { entry = join(dist, "index.mjs"); await fs.access(entry); }
  const { cases, takes = [null], leadingSilenceMs } = await readJson(join(here, "scenario.json"));
  if (!cases.length || !takes.length || !Number.isFinite(leadingSilenceMs) || leadingSilenceMs < 0 ||
      new Set(cases.map((c) => c.id)).size !== cases.length || new Set(takes.map((t) => t?.id)).size !== takes.length ||
      takes.some((t) => t !== null && !idPattern.test(t.id ?? "")) ||
      cases.some((c) => !idPattern.test(c.id ?? "") || !c.segments?.length ||
        !Number.isFinite(c.segments.at(-1).pauseAfterMs) || c.segments.at(-1).pauseAfterMs < 0 ||
        !words(c.expected.text) || !["before", "after"].includes(c.expected.finalRelativeToStop))) {
    fail("Invalid scenario");
  }
  if ((await fs.statfs("/dev/shm")).type !== 0x01021994 ||
      (await fs.readFile("/proc/swaps", "utf8")).trim().split("\n").length > 1) {
    fail("This Linux runner requires /dev/shm tmpfs and swap disabled");
  }
  const work = await fs.mkdtemp("/dev/shm/openclaw-dictation-");
  let output, step = "prepare isolated run";
  try {
    const results = join(here, "results");
    await fs.mkdir(results, { mode: 0o700 }); // Refuse stale results.
    output = results;
    delete process.env.DEBUG;
    delete process.env.PWDEBUG;
    Object.assign(process.env, { TMPDIR: work, TMP: work, TEMP: work });
    const { chromium } = createRequire(join(repo, "ui", "package.json"))("playwright");
    const port = await freePort();
    const origin = "http://127.0.0.1:" + port;
    const browserEnv = { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: work, TMPDIR: work,
      TMP: work, TEMP: work, XDG_CACHE_HOME: work, XDG_CONFIG_HOME: work, XDG_DATA_HOME: work };
    const gwEnv = { ...browserEnv, OPENCLAW_HOME: work, OPENCLAW_STATE_DIR: join(work, "state"),
      OPENCLAW_CONFIG_PATH: join(work, "config.json"), OPENCLAW_NO_RESPAWN: "1", OPENCLAW_GATEWAY_TOKEN: token };
    const chatModel = "openai/gpt-5.4-mini";
    await writeJson(gwEnv.OPENCLAW_CONFIG_PATH, {
      gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token" },
        controlUi: { enabled: true, root: join(dist, "control-ui") } },
      agents: { defaults: { model: { primary: chatModel }, models: { [chatModel]: {} } } },
      logging: { level: "silent" }, cron: { enabled: false },
      plugins: { allow: ["openai", "voice-call"], entries: {
        openai: { enabled: true }, "voice-call": { config: { enabled: false, streaming: {
          provider: "openai", providers: { openai: { silenceDurationMs: 1200 } },
        } } },
      } },
    });
    step = "start isolated Gateway";
    const gateway = spawn(process.execPath, [entry, "gateway", "run"], {
      cwd: work, env: { ...gwEnv, OPENAI_API_KEY: key }, stdio: "ignore",
    });
    let spawnError;
    gateway.on("error", (error) => { spawnError = error; });
    const exited = new Promise((done) => gateway.once("close", done));
    try {
      await waitFor(async () => {
        if (spawnError) throw spawnError;
        if (gateway.exitCode !== null || gateway.signalCode !== null) fail("Isolated Gateway exited during startup");
        return fetch(origin + "/readyz", { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
      }, 90_000, "Isolated Gateway did not become ready");
      const cli = async (args) => {
        try {
          return (await run(process.execPath, [entry, ...args], {
            cwd: work, env: gwEnv, timeout: 30_000, maxBuffer: 1 << 20,
          })).stdout;
        } catch (cause) {
          // Never include child stdout/stderr: dashboard output contains a grant.
          fail("Isolated CLI " + args.slice(0, 3).filter((s) => !s.startsWith("--")).join(" ") +
            (cause.killed ? " timed out" : " failed"));
        }
      };
      step = "run cases and write summary";
      const summary = [];
      for (const c of cases) {
        const rows = [];
        for (const take of takes) {
          const status = await runTake(c, take, { chromium, cli, origin, work, env: browserEnv, output, leadingSilenceMs });
          rows.push({ take: take?.id ?? null, status });
        }
        summary.push({ id: c.id, status: verdict(rows.map((r) => r.status)), takes: rows });
      }
      await writeJson(join(output, "summary.json"), { buildCommit: head, cases: summary });
      process.exitCode = summary.some((c) => c.status === "FAIL" || c.status === "ERROR") ? 1
        : summary.some((c) => c.status === "INCONCLUSIVE_STT") ? 2 : 0;
    } finally {
      gateway.kill("SIGTERM");
      await Promise.race([exited, sleep(5000, null, { ref: false })]);
      if (gateway.exitCode === null && gateway.signalCode === null) gateway.kill("SIGKILL");
      await exited;
    }
  } catch (cause) {
    if (output) await writeJson(join(output, "runner-error.json"), diagnostic(step, cause));
    throw cause;
  } finally { await fs.rm(work, { recursive: true, force: true }); }
}

try { await main(); } catch {
  console.error("Proof runner did not complete. Check prerequisites and results/runner-error.json, if present.");
  process.exitCode = 1;
}
