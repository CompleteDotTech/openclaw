import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const head = "10ea9589f0305145836d0d80c59c6d804b80a836";
const tree = "8a77ed824756d8f476b583f2a85ff46c9b92288d";
const transcript = "Please bring the blue folder to the meeting.";
const initial = "Meeting note:";
const edited = "Meeting note: Please bring the green folder instead.";

const target = process.argv[2] || process.env.PROOF_PR_DIR;
assert(target, "Pass the built PR checkout or set PROOF_PR_DIR");
const checkout = resolve(target);
const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
assert.equal(git("rev-parse", "HEAD"), head);
assert.equal(git("rev-parse", "HEAD^{tree}"), tree);
assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
assert.equal(JSON.parse(await readFile(join(checkout, "dist/build-info.json"), "utf8")).commit, head);
const ui = join(checkout, "dist/control-ui");
await access(join(ui, "index.html"));
const { chromium } = createRequire(join(checkout, "ui/package.json"))("playwright");

const results = resolve(process.env.PROOF_RESULTS_DIR || "proof-results");
await mkdir(results, { recursive: true });
const out = await mkdtemp(join(results, "offline-dictation-"));
const scratch = await mkdtemp(join(tmpdir(), "dp-"));
const result = { head, tree, lane: "real-gateway-local-cli-stt", status: "FAIL", stage: "setup" };
let browser, gateway, gatewayExit, catalog, page;

const listen = async (handler) => {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
};
const close = (server) => new Promise((done, fail) => {
  server.close((error) => error ? fail(error) : done());
  server.closeAllConnections();
});
const until = async (probe, ms = 20_000) => {
  const end = Date.now() + ms;
  do {
    const value = await probe();
    if (value) return value;
    await delay(75);
  } while (Date.now() < end);
  throw new Error("Timed out: " + result.stage);
};
const shot = (name) => page.screenshot({
  path: join(out, name + ".png"), animations: "disabled",
});
const readFrame = (message) => {
  try { return JSON.parse(message.toString()); } catch { return null; }
};

try {
  const work = join(scratch, "work");
  await mkdir(work);
  const calls = join(scratch, "stt-calls.txt");
  const stt = join(scratch, "transcribe.mjs");
  await writeFile(stt, [
    'import assert from "node:assert/strict";',
    'import { appendFileSync, readFileSync } from "node:fs";',
    'const wav = readFileSync(process.argv[2]);',
    'assert.equal(wav.toString("ascii", 0, 4), "RIFF");',
    'assert.equal(wav.toString("ascii", 8, 12), "WAVE");',
    'assert.equal(wav.readUInt16LE(22), 1);',
    'assert.equal(wav.readUInt32LE(24), 8000);',
    'assert.equal(wav.readUInt16LE(34), 16);',
    'const bytes = wav.readUInt32LE(40);',
    'assert(bytes >= 8000 && bytes === wav.length - 44);',
    'appendFileSync(process.argv[3], String(bytes) + "\\n");',
    'console.log(' + JSON.stringify(transcript) + ');',
  ].join("\n"));

  // Three seconds of mono PCM16 at 48 kHz for Chromium's fake microphone.
  const clip = join(scratch, "mic.wav");
  const samples = 48_000 * 3;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48_000, 24); wav.writeUInt32LE(96_000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    wav.writeInt16LE(Math.round(5000 * Math.sin(2 * Math.PI * 440 * i / 48_000)), 44 + i * 2);
  }
  await writeFile(clip, wav);

  // Keyless catalog only: keep the composer usable without enabling inference.
  let inferenceRequests = 0;
  const model = "proof-model";
  const info = { name: model, model, details: { family: "llama" } };
  catalog = await listen((req, res) => {
    const path = req.url?.split("?")[0];
    res.setHeader("Content-Type", "application/json");
    if (path === "/api/tags") return res.end(JSON.stringify({ models: [info] }));
    if (path === "/api/show") return res.end(JSON.stringify({ ...info, capabilities: ["completion"] }));
    if (path === "/api/version") return res.end(JSON.stringify({ version: "0.20.0" }));
    if (/chat|generate|completions/.test(path ?? "")) inferenceRequests++;
    res.writeHead(404).end();
  });

  const reservation = await listen();
  const { port } = reservation.address();
  await close(reservation);
  const origin = "http://127.0.0.1:" + port;
  const config = join(scratch, "openclaw.json");
  await writeFile(config, JSON.stringify({
    gateway: {
      mode: "local", bind: "loopback", port, auth: { mode: "none" },
      controlUi: { enabled: true, root: ui }, tailscale: { mode: "off" },
    },
    agents: { defaults: {
      workspace: work, heartbeat: { every: "0m" }, model: { primary: "ollama/" + model },
    } },
    models: { catalogRefresh: { enabled: false }, providers: { ollama: {
      api: "ollama", baseUrl: "http://127.0.0.1:" + catalog.address().port,
      models: [{ id: model, name: model, input: ["text"], contextWindow: 8192, maxTokens: 1024 }],
    } } },
    plugins: { allow: ["ollama"], entries: { ollama: { enabled: true } } },
    cron: { enabled: false },
    update: { checkOnStart: false },
    logging: { file: join(scratch, "gateway.log") },
    tools: { profile: "minimal", media: { audio: { enabled: true }, models: [{
      type: "cli", command: process.execPath, args: [stt, "{{AttachmentPath}}", calls],
      capabilities: ["audio"], timeoutSeconds: 10,
    }] } },
  }), { mode: 0o600 });

  result.stage = "start isolated Gateway";
  // Construct the child environment; don't inherit keys, tokens, or NODE_OPTIONS.
  const local = {
    PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C.UTF-8",
    HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
  };
  const log = await open(join(out, "gateway.log"), "w");
  try {
    gateway = spawn(process.execPath, [
      join(checkout, "openclaw.mjs"), "gateway", "run", "--bind", "loopback", "--port", String(port),
    ], {
      cwd: work, detached: true, stdio: ["ignore", log.fd, log.fd],
      env: {
        ...local,
        OPENCLAW_HOME: scratch,
        OPENCLAW_STATE_DIR: join(scratch, "state"),
        OPENCLAW_CONFIG_PATH: config,
        OPENCLAW_GATEWAY_PORT: String(port),
        OPENCLAW_INTERNAL_WORKER_TMPDIR: scratch,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_DISABLE_BONJOUR: "1",
        NODE_DISABLE_COMPILE_CACHE: "1",
      },
    });
    gatewayExit = new Promise((done) => {
      gateway.once("error", (error) => done(error.message));
      gateway.once("exit", (code, signal) => done(String(signal ?? code)));
    });
  } finally {
    await log.close();
  }
  let stopped;
  void gatewayExit.then((reason) => { stopped = reason; });
  await until(async () => {
    assert.equal(stopped, undefined, "Gateway exited before readiness: " + stopped);
    return fetch(origin + "/readyz", { signal: AbortSignal.timeout(1000) })
      .then((response) => response.ok, () => false);
  }, 120_000);

  result.stage = "open production chat composer and wait for transcription readiness";
  browser = await chromium.launch({ env: local, args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--use-file-for-fake-audio-capture=" + clip,
  ] });
  const ctx = await browser.newContext({
    locale: "en-US", colorScheme: "dark",
    viewport: { width: 1440, height: 1000 }, serviceWorkers: "block",
  });
  await ctx.grantPermissions(["microphone"], { origin });
  page = await ctx.newPage();
  page.setDefaultTimeout(20_000);

  const pending = new Map();
  const talk = [];
  const sends = [];
  const finals = [];
  const errors = [];
  let catalogReady = false, admission, audioBytes = 0, terminal;
  const sendMethods = new Set([
    "chat.send", "sessions.send", "agent", "sessions.dispatch", "sessions.companion.ask",
  ]);

  // Pass through real Gateway traffic. Reject only unexpected sends and fail on the attempt.
  await page.routeWebSocket((url) => url.host === new URL(origin).host, (client) => {
    const server = client.connectToServer();
    client.onMessage((raw) => {
      const frame = readFrame(raw);
      if (frame?.type === "req") {
        if (sendMethods.has(frame.method)) {
          sends.push(frame.method);
          client.send(JSON.stringify({
            type: "res", id: frame.id, ok: false,
            error: { code: "INVALID_REQUEST", message: "Unexpected send in offline proof" },
          }));
          return;
        }
        if (["talk.catalog", "talk.session.create"].includes(frame.method)) {
          pending.set(frame.id, frame.method);
        }
        if (frame.method.startsWith("talk.session.")) {
          talk.push({
            method: frame.method, mode: frame.params?.mode,
            sessionId: frame.params?.sessionId, discard: frame.params?.discard,
          });
        }
      }
      server.send(raw);
    });
    server.onMessage((raw) => {
      const frame = readFrame(raw);
      const data = frame?.payload;
      if (frame?.type === "res") {
        const method = pending.get(frame.id);
        pending.delete(frame.id);
        if (method === "talk.catalog" && frame.ok && data?.transcription?.ready) catalogReady = true;
        if (method === "talk.session.create") admission = data?.transcriptionSessionId || false;
      } else if (frame?.type === "event" && frame.event === "talk.event" &&
          admission && data?.transcriptionSessionId === admission) {
        if (data.type === "inputAudio") audioBytes += data.byteLength;
        if (data.type === "transcript" && data.final && data.text?.trim()) finals.push(data.text.trim());
        if (data.type === "error") errors.push(data.type);
        if (data.type === "close") terminal = data.reason;
      }
      client.send(raw);
    });
  });

  await page.goto(origin + "/chat/main");
  await page.waitForFunction(() => window.openclawControlUi?.snapshot().gatewayPhase === "connected");
  const root = page.locator(".agent-chat__composer-shell:visible").filter({
    has: page.getByRole("textbox", { name: "Chat composer", exact: true }),
  });
  const draft = root.getByRole("textbox", { name: "Chat composer", exact: true });
  const button = (name) => root.getByRole("button", { name, exact: true });
  await until(() => catalogReady);

  result.stage = "capture, stop and transcribe";
  await draft.fill(initial);
  await draft.press("End");
  await button("Start voice input").hover();
  await page.mouse.down();
  try { await until(() => talk.some((r) => r.method === "talk.session.create")); }
  finally { await page.mouse.up(); }
  await until(() => admission !== undefined);
  assert(admission, "Gateway did not admit dictation");
  // 4,000 μ-law bytes decode to at least 8,000 bytes of PCM16 at the CLI boundary.
  await until(() => terminal || audioBytes >= 4000);
  assert.equal(terminal, undefined, "Capture closed before Stop");
  await button("Stop and keep text").click();
  assert.equal(await until(() => terminal), "completed");
  assert.deepEqual(errors, []);
  assert.deepEqual(finals, [transcript]);
  const starts = talk.filter((r) => r.method === "talk.session.create");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].mode, "transcription");
  const stops = talk.filter((r) => r.method === "talk.session.close");
  assert.equal(stops.length, 1);
  assert.equal(stops[0].sessionId, admission);
  assert(!stops[0].discard);

  const sttCalls = async () => (await readFile(calls, "utf8")).trim().split("\n").map(Number);
  const received = await sttCalls();
  assert.equal(received.length, 1);
  assert(received[0] >= 8000);
  result.fixturePcmBytes = received[0];
  const committed = initial + " " + transcript;
  await until(async () => (await draft.inputValue()) === committed);

  result.stage = "preview original without changing the draft";
  const profiles = root.locator("details.composer-writing-profiles");
  await profiles.locator(":scope > summary").click();
  await profiles.getByText("Review original", { exact: true }).click();
  const original = profiles.getByLabel("Original transcript", { exact: true });
  const retry = profiles.getByRole("button", { name: "Reprocess unsent draft", exact: true });
  const preview = profiles.getByText(/^Preview only\. The original transcript is preserved/);
  const success = profiles.getByText("Original transcript previewed without changing the draft.", {
    exact: true,
  });
  assert.equal(await original.inputValue(), transcript);
  const captureTraffic = talk.length;
  await retry.click();
  await preview.waitFor({ state: "visible" });
  assert.equal(await draft.inputValue(), committed);
  assert.equal(await original.inputValue(), transcript);
  await shot("01-preview");

  result.stage = "edit and reject retry without recapture or send";
  await draft.fill(edited);
  await retry.click();
  await profiles.getByText(/^A new preview is unavailable while capture is busy/).waitFor();
  await shot("02-retry");
  assert.equal(await draft.inputValue(), edited);
  assert.equal(await original.inputValue(), transcript);
  assert.equal(talk.length, captureTraffic, "Preview/retry made a new capture RPC");
  assert.deepEqual(await sttCalls(), received, "Preview/retry reran transcription");
  assert.deepEqual(sends, [], "Preview/retry attempted a send");
  assert.equal(inferenceRequests, 0, "Unexpected inference request");

  result.stage = "check stale success after blocked retry";
  result.stalePreviewVisible = (await preview.isVisible()) || (await success.isVisible());
  assert(!result.stalePreviewVisible, "Blocked retry still shows an earlier preview success");
  result.status = "PASS";
} catch (error) {
  result.error = error.message;
  console.error(result.stage + ": " + result.error);
  process.exitCode = 1;
  if (page) await shot("failure").catch(() => {});
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      if (gateway?.pid) {
        const signal = (name) => {
          try { process.kill(-gateway.pid, name); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        };
        signal("SIGTERM");
        if (!await Promise.race([gatewayExit.then(() => true), delay(5000, false, { ref: false })])) {
          signal("SIGKILL");
          await gatewayExit;
        }
      }
    } finally {
      try { if (catalog) await close(catalog); }
      finally {
        await rm(scratch, { recursive: true, force: true });
        await writeFile(join(out, "case.json"), JSON.stringify(result, null, 2) + "\n");
        console.log(out);
      }
    }
  }
}
