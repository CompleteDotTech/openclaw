import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

class ProofError extends Error {}
class InconclusiveSTT extends ProofError {}
function check(ok, message) {
  if (!ok) throw new ProofError(message);
}
async function until(read, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await sleep(80);
  } while (Date.now() < deadline);
  throw new ProofError(`Timed out: ${label}`);
}

const here = fileURLToPath(new URL(".", import.meta.url));
const apiKey = process.env.OPENAI_API_KEY?.trim();
delete process.env.OPENAI_API_KEY;

const REVIEW = ".composer-file-references__review";
const DRAFT = "textarea[data-composer-file-references]";
const CHIP = ".chat-composer-file-reference";
const COMPOSER = ".agent-chat__composer-shell";

function wavDurationMs(b) {
  check(b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE",
    "Expected a RIFF/WAVE clip.");
  let formatOK = false;
  let dataBytes = 0;
  for (let at = 12; at + 8 <= b.length;) {
    const name = b.toString("ascii", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    const data = at + 8;
    check(data + size <= b.length, "Truncated WAV chunk.");
    if (name === "fmt " && size >= 16) {
      formatOK = b.readUInt16LE(data) === 1 && b.readUInt16LE(data + 2) === 1 &&
        b.readUInt32LE(data + 4) === 48000 && b.readUInt16LE(data + 14) === 16;
    }
    if (name === "data") dataBytes = size;
    at = data + size + size % 2;
  }
  check(formatOK && dataBytes > 0, "Expected nonempty 48 kHz mono PCM16 WAV.");
  return Math.ceil(dataBytes / 96);
}

function command(text) {
  const matches = [...text.matchAll(/\breference file\s+(.+?)\s+end reference\b/gi)];
  return matches.length === 1 ? matches[0] : null;
}
function spokenPath(text) {
  return text.trim().replace(/\s+(?:forward\s+)?slash\s+/gi, "/")
    .replace(/\s+dot\s+/gi, ".");
}
function words(text) {
  const m = command(text);
  if (m) text = text.replace(m[0], `reference file ${spokenPath(m[1])} end reference`);
  return (text.toLowerCase().replaceAll("’", "'")
    .match(/@?[\p{L}\p{N}]+(?:['/.][\p{L}\p{N}]+)*/gu) ?? []).join(" ");
}
function classifyTranscript(text, c) {
  const m = command(text);
  if (!m || spokenPath(m[1]) !== c.commandFile || words(text) !== words(c.expectedTranscript)) {
    throw new InconclusiveSTT("Final STT did not return the intended words and path.");
  }
  const singleQuoted = /'let['’]s use reference file notes end reference[,.]?'|‘let['’]s use reference file notes end reference[,.]?’/i;
  if (c.requiresSingleQuotes && !singleQuoted.test(text)) {
    throw new InconclusiveSTT("Final STT did not return the required single-quoted command.");
  }
  return m;
}
function parseFrame(payload) {
  try { return JSON.parse(payload.toString()); } catch { return null; }
}
async function tabTo(page, target) {
  await target.waitFor({ state: "visible" });
  for (let i = 0; i < 24; i++) {
    if (await target.evaluate((el) => el.matches(":focus"))) return;
    await page.keyboard.press("Tab");
  }
  throw new ProofError("Could not reach the chooser control by Tab.");
}

async function runCase(c, h) {
  const out = join(h.results, c.id);
  await mkdir(out);
  let stage = "create fixture session";
  let status = "FAIL", detail = null, screenshot = null, chooserScreenshot = null;
  let browser, page, draft, createId, closeId, opened, closeOK, firstAudioAt;
  const events = [], fileActions = [];
  const relayEvents = () => events.filter((e) => e.id === opened?.transcriptionSessionId);
  const finalParts = () => relayEvents()
    .filter((e) => e.type === "transcript" && e.final === true && typeof e.text === "string")
    .map((e) => e.text);
  const transcript = () => finalParts().map((s) => s.trim()).filter(Boolean).join(" ");

  try {
    h.createSession(c.id);
    stage = "load WAV and launch Chromium";
    const clip = join(here, "clips", `${c.id}.wav`);
    const duration = wavDurationMs(await readFile(clip));
    browser = await h.chromium.launch({
      headless: true,
      env: h.ramEnv,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${clip}%noloop`,
      ],
    });
    const context = await browser.newContext({
      locale: "en-US", viewport: { width: 1440, height: 1000 },
      permissions: ["microphone"], serviceWorkers: "block",
    });
    page = await context.newPage();
    page.setDefaultTimeout(15_000);

    page.on("websocket", (ws) => {
      if (new URL(ws.url()).host !== new URL(h.origin).host) return;
      ws.on("framesent", ({ payload }) => {
        const f = parseFrame(payload);
        if (f?.type !== "req") return;
        if (f.method === "talk.session.create" && f.params?.mode === "transcription") createId = f.id;
        if (f.method === "talk.session.appendAudio") firstAudioAt ??= Date.now();
        if (f.method === "talk.session.close" && !f.params?.discard) closeId = f.id;
        if (f.method === "sessions.files.references") fileActions.push(f.params?.action);
      });
      ws.on("framereceived", ({ payload }) => {
        const f = parseFrame(payload);
        if (f?.type === "res" && f.id === createId) opened = f.ok ? f.payload : false;
        if (f?.type === "res" && f.id === closeId) closeOK = f.ok === true;
        const p = f?.payload;
        if (f?.type === "event" && f.event === "talk.event" && p?.transcriptionSessionId) {
          events.push({
            id: p.transcriptionSessionId, type: p.type, final: p.final, text: p.text, reason: p.reason,
          });
        }
      });
    });

    stage = "open real Chat and opt in";
    await page.goto(`${h.origin}/chat/main/dictation-${c.id}#token=${h.token}`);
    await page.getByRole("checkbox", {
      name: "English file-reference commands for this session's local workspace", exact: true,
    }).check();
    draft = page.locator(DRAFT);
    check(await draft.inputValue() === "", "Expected a fresh empty draft.");
    await page.evaluate((selector) => {
      window.__proofChooserSeen = Boolean(document.querySelector(selector));
      new MutationObserver((records) => {
        if (document.querySelector(selector) || records.some((record) =>
          [...record.addedNodes].some((n) =>
            n instanceof Element && (n.matches(selector) || n.querySelector(selector))))) {
          window.__proofChooserSeen = true;
        }
      }).observe(document.body, { childList: true, subtree: true });
    }, REVIEW);

    stage = "hold mic, play clip, and stop";
    const mic = page.getByRole("button", { name: "Start voice input", exact: true });
    await mic.scrollIntoViewIfNeeded();
    const box = await mic.boundingBox();
    check(box, "Mic button is not visible.");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
      await page.locator(".agent-chat__dictation-phase--listening").waitFor();
    } finally {
      await page.mouse.up();
    }
    await until(() => opened !== undefined, "transcription session response");
    check(opened?.provider === "openai", "Gateway did not select OpenAI transcription.");
    await until(() => firstAudioAt, "first microphone frame");
    await sleep(Math.max(0, firstAudioAt + duration + 200 - Date.now()));
    await page.getByRole("button", { name: "Stop and keep text", exact: true }).click();

    stage = "verify provider completion and input";
    await until(() => closeOK !== undefined, "dictation close acknowledgement", 60_000);
    check(closeOK, "Gateway rejected dictation close.");
    await until(() => relayEvents().some((e) => e.type === "close"), "provider close event");
    check(relayEvents().some((e) => e.type === "close" && e.reason === "completed") &&
      !relayEvents().some((e) => e.type === "error"), "OpenAI relay did not complete cleanly.");
    await page.locator(".agent-chat__dictation-status").waitFor({ state: "hidden" });
    const raw = transcript();
    const m = classifyTranscript(raw, c);

    const expectDraft = (value) => page.waitForFunction(
      ({ selector, value }) => document.querySelector(selector)?.value === value,
      { selector: DRAFT, value },
      { timeout: 15_000 },
    );
    stage = "verify chooser and composer";
    await expectDraft(raw);
    const review = page.locator(REVIEW);
    const chip = page.locator(CHIP);
    let expected = raw;
    if (c.chooser.opens) {
      await review.getByRole("heading", { name: "Choose a file reference", exact: true }).waitFor();
      const radio = review.getByRole("radio", { name: c.chooser.select, exact: true });
      await radio.waitFor();
      await until(() => radio.isEnabled(), "candidate enabled");
      check(!(await radio.isChecked()), "Candidate was already selected.");
      // Anchor focus at the query; all selection and activation are by keyboard.
      await review.getByRole("textbox", { name: "Filename or relative path" }).focus();
      await tabTo(page, radio);
      await page.keyboard.press("Space");
      await until(() => radio.isChecked(), "candidate selected using Space");
      chooserScreenshot = await page.locator(COMPOSER).screenshot({
        path: join(out, "chooser.png"), timeout: 5_000,
      }).then(() => "chooser.png", () => null);

      if (c.chooser.exitKey === "Enter") {
        await tabTo(page, review.getByRole("button", { name: "Insert bound reference", exact: true }));
        await page.keyboard.press("Enter");
        const label = `@${c.chooser.select}`;
        expected = raw.slice(0, m.index) + label + raw.slice(m.index + m[0].length);
        await chip.waitFor();
        check(await chip.textContent() === label, "Bound chip has the wrong label.");
        check(fileActions.includes("revalidate"), "Confirm did not revalidate the selected file.");
      } else {
        check(c.chooser.exitKey === "Escape", "Invalid expected chooser exit key.");
        await page.keyboard.press("Escape");
      }
    } else {
      check(!(await page.evaluate(() => window.__proofChooserSeen)), "Quoted command opened the chooser.");
      check(fileActions.length === 0, "Quoted command contacted the file resolver.");
    }
    await review.waitFor({ state: "hidden" });
    await expectDraft(expected);
    const value = await draft.inputValue();
    const confirmed = c.chooser.exitKey === "Enter";
    check(value === expected, "Composer changed text outside the expected edit.");
    check(words(value) === words(c.expectedComposer), "Composer did not match the expected result.");
    check(await chip.count() === (confirmed ? 1 : 0), "Wrong number of bound chips.");
    check(confirmed || !fileActions.includes("revalidate"), "Unexpected file revalidation.");
    status = "PASS";
  } catch (error) {
    status = error instanceof InconclusiveSTT ? "INCONCLUSIVE_STT" : "FAIL";
    // Playwright errors can include credential-bearing navigation URLs.
    detail = error instanceof ProofError ? error.message : `Failed during: ${stage}.`;
  } finally {
    const finalComposer = draft ? await draft.inputValue({ timeout: 1_000 }).catch(() => null) : null;
    if (draft) {
      screenshot = await page.locator(COMPOSER).screenshot({
        path: join(out, "final.png"), timeout: 5_000,
      }).then(() => "final.png", () => null);
    }
    await browser?.close().catch(() => {});
    if (status === "PASS" && (!screenshot || (c.chooser.opens && !chooserScreenshot))) {
      status = "FAIL";
      detail = "Behavior passed, but a required screenshot is missing.";
    }
    await h.save(join(out, "transcript.txt"), transcript());
    await h.save(join(out, "composer.txt"), finalComposer ?? "");
    await h.save(join(out, "case.json"), JSON.stringify({
      head: h.head, status, detail, stage, screenshot, chooserScreenshot,
      provider: opened?.provider === "openai" ? "openai" : null,
      finalTranscriptParts: finalParts(), finalComposer, fileActions,
    }, null, 2) + "\n");
  }
  console.log(`${c.id}: ${status}${detail ? ` — ${detail}` : ""}`);
  return status;
}

async function main() {
  check(process.argv[2], "Usage: node dictation-proof.mjs <built PR checkout>");
  check(apiKey, "Set OPENAI_API_KEY in the run step.");
  check(process.platform === "linux" && (await statfs("/dev/shm")).type === 0x01021994,
    "Expected Linux tmpfs at /dev/shm.");
  check((await readFile("/proc/swaps", "utf8")).trim().split("\n").length === 1,
    "Swap is enabled. Turn it off on this disposable runner before using the secret.");

  const repo = resolve(process.argv[2]);
  const launcher = join(repo, "openclaw.mjs");
  const uiRoot = join(repo, "dist", "control-ui");
  await access(join(uiRoot, "index.html"));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const { cases } = JSON.parse(await readFile(join(here, "scenario.json"), "utf8"));
  check(cases.length > 0 && cases.every((c) => /^[a-z0-9-]+$/.test(c.id)),
    "Expected nonempty scenario with kebab-case IDs.");

  await mkdir(join(here, "results"), { recursive: true });
  const results = await mkdtemp(join(here, "results", "run-"));
  const ram = await mkdtemp("/dev/shm/openclaw-dictation-");
  const token = randomBytes(32).toString("hex");
  let child, done, exited = false, startError = false;
  const previousTmp = process.env.TMPDIR;
  try {
    // Playwright creates its Chromium user-data directory using the parent tmpdir.
    process.env.TMPDIR = ram;
    const { chromium } = createRequire(join(repo, "ui", "package.json"))("playwright");
    const ramEnv = {
      PATH: process.env.PATH, LANG: "C.UTF-8", HOME: ram,
      TMPDIR: ram, TMP: ram, TEMP: ram,
      XDG_CONFIG_HOME: join(ram, "xdg-config"), XDG_CACHE_HOME: join(ram, "xdg-cache"),
      XDG_DATA_HOME: join(ram, "xdg-data"), XDG_STATE_HOME: join(ram, "xdg-state"),
      NODE_DISABLE_COMPILE_CACHE: "1",
    };
    const localEnv = {
      ...ramEnv, OPENCLAW_HOME: ram, OPENCLAW_STATE_DIR: join(ram, "state"),
      OPENCLAW_CONFIG_PATH: join(ram, "openclaw.json"),
      OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_SKIP_CHANNELS: "1",
    };

    const socket = createServer().listen(0, "127.0.0.1");
    await once(socket, "listening");
    const { port } = socket.address();
    await new Promise((resolveClose, reject) => socket.close((err) =>
      err ? reject(err) : resolveClose()));
    const origin = `http://127.0.0.1:${port}`;
    const workspace = join(ram, "fixture-workspace");
    await mkdir(join(workspace, "src"), { recursive: true });
    for (const path of ["src/auth.ts", "notes", "checklist"]) {
      await writeFile(join(workspace, path), "Synthetic proof fixture\n");
    }
    await writeFile(localEnv.OPENCLAW_CONFIG_PATH, JSON.stringify({
      gateway: {
        mode: "local", bind: "loopback", port, auth: { mode: "token" },
        controlUi: { enabled: true, root: uiRoot },
      },
      agents: { defaults: { workspace, voiceModel: "openai/gpt-4o-transcribe" } },
      plugins: { entries: { openai: { enabled: true } } },
    }), { mode: 0o600 });

    child = spawn(process.execPath, [launcher, "gateway", "run", "--bind", "loopback"], {
      cwd: repo, env: { ...localEnv, OPENAI_API_KEY: apiKey }, stdio: "ignore", detached: true,
    });
    child.on("error", () => { startError = true; });
    done = new Promise((finish) => child.once("close", () => { exited = true; finish(); }));
    await until(async () => {
      check(!startError && !exited, "Gateway exited before readiness.");
      const response = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(2_000) })
        .catch(() => null);
      return response?.ok;
    }, "loopback Gateway readiness", 180_000);

    const createSession = (id) => execFileSync(process.execPath, [
      launcher, "gateway", "call", "sessions.create",
      "--expect-url", `ws://127.0.0.1:${port}`, "--timeout", "30000", "--json",
      "--params", JSON.stringify({ agentId: "main", key: `agent:main:dictation-${id}`, label: id }),
    ], { cwd: repo, env: localEnv, timeout: 45_000, stdio: "ignore" });

    const save = (path, text) => writeFile(path,
      text.replaceAll(apiKey, "[redacted]").replaceAll(token, "[redacted]"), { mode: 0o600 });
    for (const c of cases) {
      if (await runCase(c, { chromium, ramEnv, origin, token, createSession, results, head, save }) !== "PASS") {
        process.exitCode = 1;
      }
    }
  } finally {
    if (child?.pid && !exited) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      await Promise.race([done, sleep(5_000, undefined, { ref: false })]);
      if (!exited) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
        await done;
      }
    }
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    await rm(ram, { recursive: true, force: true });
    console.log(`Artifacts: ${results}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof ProofError ? error.message : "Harness setup or cleanup failed.");
  process.exitCode = 1;
}
