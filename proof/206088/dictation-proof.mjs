import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

class ProofError extends Error {
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}
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
const CHIP = ".chat-composer-file-reference";
const COMPOSER = ".agent-chat__composer-shell";
const DRAFT = COMPOSER + ' textarea[aria-label="Chat composer"]';
const CHAT_MODEL = "openai/gpt-5.4-mini";
const SEND_METHODS = new Set(["chat.send", "sessions.send", "agent"]);

function redact(text, secrets) {
  let safe = String(text);
  for (const secret of secrets) {
    safe = safe.replaceAll(secret, "[redacted]");
    safe = safe.replaceAll(encodeURIComponent(secret), "[redacted]");
  }
  return safe;
}

function diagnostic(text, secrets) {
  return redact(text, secrets)
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s"',;<>]+/gi, "[redacted authorization]")
    .replace(/\b(?:authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/gi, "[redacted header]")
    .replace(/\bsk-[a-z0-9_-]{8,}\b/gi, "[redacted key]")
    .slice(0, 2400);
}

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

function words(s) {
  return (s.toLowerCase().replaceAll("’", "'")
    .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? []).join(" ");
}

// Mirror the resolver's spoken matching for these synthetic fixtures.
// Never use the browser's actual chooser outcome to qualify the input.
function matchesFixture(query, expected) {
  const path = query.trim().replaceAll("\\", "/");
  if (/[:\u0000-\u001f\u007f]/u.test(path) ||
      path.split("/").some((p) => !p || p.startsWith("."))) return false;
  const tokens = (s) => s.replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2")
    .normalize("NFC").toLocaleLowerCase("en-US").split(/[\s/._-]+/u).filter(Boolean);
  const q = tokens(path), file = tokens(expected);
  return path === expected || path === expected.split("/").at(-1) ||
    (q.length > 0 && q.every((token) => file.includes(token)));
}

function qualify(raw, c, recognize) {
  const parse = (s) => recognize(s, { locale: "en-US", literal: false, commandMode: false });
  const plan = parse(raw);
  function intended(parsed, offset) {
    if (parsed.status !== "ready" || parsed.commands.length !== 1) return null;
    const cmd = parsed.commands[0];
    const start = cmd.start + offset, end = cmd.end + offset;
    if (cmd.kind !== "file" || !matchesFixture(cmd.query, c.file) ||
        words(raw.slice(0, start)) !== words(c.before) ||
        words(raw.slice(end)) !== words(c.after)) return null;
    return { start, end, query: cmd.query, recognizedCommands: plan.commands.length };
  }
  if (!c.singleQuoted) return intended(plan, 0);

  // Locate an actual single-quoted span, not a contraction. Parse its contents
  // separately so failure to protect the original span doesn't disqualify it.
  const quotes = /(?<![\p{L}\p{M}\p{N}])'(?:[^'\n]|(?<=[\p{L}\p{M}\p{N}])'(?=[\p{L}\p{M}\p{N}]))*'(?![\p{L}\p{M}\p{N}])|‘(?:[^’\n]|(?<=[\p{L}\p{M}\p{N}])’(?=[\p{L}\p{M}\p{N}]))*’(?![\p{L}\p{M}\p{N}])/gu;
  for (const span of raw.matchAll(quotes)) {
    const result = intended(parse(span[0].slice(1, -1)), span.index + 1);
    if (result) return result;
  }
  return null;
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

async function runTake(c, take, h) {
  const clipId = `${c.id}--${take.id}`;
  const out = join(h.results, c.id, take.id);
  await mkdir(out);
  let stage = "create fixture session";
  let status = "FAIL", failure = null, screenshot = null, chooserScreenshot = null;
  let browser, page, draft, connectId, createId, closeId, opened, closeOK, firstAudioAt;
  let gatewayMessage, clipSha256, qualified;
  const events = [], fileActions = [], blockedSends = [];
  const secrets = new Set([apiKey, h.token]);
  const remember = (value) => {
    if (typeof value === "string" && value.length >= 8) secrets.add(value);
  };
  const relayEvents = () => events.filter((e) => e.id === opened?.transcriptionSessionId);
  const finalParts = () => relayEvents()
    .filter((e) => e.type === "transcript" && e.final === true && typeof e.text === "string")
    .map((e) => e.text);
  const transcript = () => finalParts().map((s) => s.trim()).filter(Boolean).join(" ");

  try {
    h.createSession(clipId);
    stage = "load WAV and launch Chromium";
    const clip = join(here, "clips", `${clipId}.wav`);
    const audio = await readFile(clip);
    clipSha256 = createHash("sha256").update(audio).digest("hex");
    const duration = wavDurationMs(audio);
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

    // Forward real Gateway traffic, except never forward a turn submission.
    await page.routeWebSocket((url) => url.host === new URL(h.origin).host, (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        const f = parseFrame(message);
        if (f?.type === "req") {
          if (SEND_METHODS.has(f.method)) {
            blockedSends.push(f.method);
            return;
          }
          if (f.method === "connect") {
            connectId = f.id;
            for (const value of Object.values(f.params?.auth ?? {})) remember(value);
          }
          if (f.method === "talk.session.create" && f.params?.mode === "transcription") createId = f.id;
          if (f.method === "talk.session.appendAudio") firstAudioAt ??= Date.now();
          if (f.method === "talk.session.close" && !f.params?.discard) closeId = f.id;
          if (f.method === "sessions.files.references") fileActions.push(f.params?.action);
        }
        server.send(message);
      });
      server.onMessage((message) => {
        const f = parseFrame(message);
        const p = f?.payload;
        if (f?.type === "res") {
          if (f.id === connectId) {
            remember(p?.auth?.deviceToken);
            for (const grant of p?.auth?.deviceTokens ?? []) remember(grant.token);
          }
          if (f.id === createId) opened = f.ok ? p : false;
          if (f.id === closeId) closeOK = f.ok === true;
          if (!f.ok && [connectId, createId, closeId].includes(f.id)) {
            gatewayMessage = f.error?.message;
          }
        }
        if (f?.type === "event" && f.event === "talk.event" && p?.transcriptionSessionId) {
          if (p.type === "error") gatewayMessage = p.message;
          events.push({
            id: p.transcriptionSessionId, type: p.type, final: p.final, text: p.text, reason: p.reason,
          });
        }
        socket.send(message);
      });
    });

    stage = "navigate to real Chat";
    await page.goto(`${h.origin}/chat/main/dictation-${clipId}#token=${h.token}`);
    stage = "mount native composer textarea";
    draft = page.locator(DRAFT);
    await draft.waitFor({ state: "attached" });
    stage = "wait for chat model setup to clear";
    await page.getByRole("button", { name: "Set up a model", exact: true })
      .waitFor({ state: "hidden", timeout: 30_000 });
    stage = "wait for editable composer";
    await page.waitForFunction((selector) => {
      const input = document.querySelector(selector);
      return input instanceof HTMLTextAreaElement && !input.disabled && !input.readOnly;
    }, DRAFT, { timeout: 30_000 });
    check(await draft.inputValue() === "", "Expected a fresh empty draft.");

    stage = "opt in to file-reference commands";
    await page.getByRole("checkbox", {
      name: "English file-reference commands for this session's local workspace", exact: true,
    }).check();
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

    stage = "hold mic and start live transcription";
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

    stage = "stream the WAV and stop dictation";
    await until(() => firstAudioAt, "first microphone frame");
    await sleep(Math.max(0, firstAudioAt + duration + 200 - Date.now()));
    await page.getByRole("button", { name: "Stop and keep text", exact: true }).click();

    stage = "verify provider completion";
    await until(() => closeOK !== undefined, "dictation close acknowledgement", 60_000);
    check(closeOK, "Gateway rejected dictation close.");
    await until(() => relayEvents().some((e) => e.type === "close"), "provider close event");
    check(relayEvents().some((e) => e.type === "close" && e.reason === "completed") &&
      !relayEvents().some((e) => e.type === "error"), "OpenAI relay did not complete cleanly.");

    stage = "qualify the final transcript";
    const raw = transcript();
    qualified = qualify(raw, c, h.recognize);
    if (!qualified) throw new InconclusiveSTT(c.singleQuoted
      ? "STT did not supply the intended command within actual single quotes."
      : "STT did not supply the intended parseable command and surrounding words.");
    check(!c.singleQuoted || qualified.recognizedCommands === 0,
      "Product parser recognized a command inside a qualified single-quoted span.");

    stage = "wait for composer dictation to settle";
    await page.locator(".agent-chat__dictation-status").waitFor({ state: "hidden" });
    const expectDraft = (value) => page.waitForFunction(
      ({ selector, value }) => document.querySelector(selector)?.value === value,
      { selector: DRAFT, value },
      { timeout: 15_000 },
    );
    stage = "verify transcript entered the draft";
    await expectDraft(raw);
    const review = page.locator(REVIEW);
    const chip = page.locator(CHIP);
    let expected = raw;

    if (c.chooser.opens) {
      stage = "wait for the chooser and intended file";
      await review.getByRole("heading", { name: "Choose a file reference", exact: true }).waitFor();
      const radio = review.getByRole("radio", { name: c.file, exact: true });
      await radio.waitFor();
      await until(() => radio.isEnabled(), "candidate enabled");
      check(!(await radio.isChecked()), "Candidate was already selected.");

      stage = "select the intended file by keyboard";
      await review.getByRole("textbox", { name: "Filename or relative path" }).focus();
      await tabTo(page, radio);
      await page.keyboard.press("Space");
      await until(() => radio.isChecked(), "candidate selected using Space");
      chooserScreenshot = await page.locator(COMPOSER).screenshot({
        path: join(out, "chooser.png"), timeout: 5_000,
      }).then(() => "chooser.png", () => null);

      if (c.chooser.exitKey === "Enter") {
        stage = "confirm the bound reference by keyboard";
        await tabTo(page, review.getByRole("button", { name: "Insert bound reference", exact: true }));
        await page.keyboard.press("Enter");
        const label = `@${c.file}`;
        expected = raw.slice(0, qualified.start) + label + raw.slice(qualified.end);
        await chip.waitFor();
        check(await chip.textContent() === label, "Bound chip has the wrong label.");
        check(fileActions.includes("revalidate"), "Confirm did not revalidate the selected file.");
      } else {
        stage = "cancel the chooser by keyboard";
        check(c.chooser.exitKey === "Escape", "Invalid expected chooser exit key.");
        await page.keyboard.press("Escape");
      }
    } else {
      stage = "verify quoted command never opened the chooser";
      check(!(await page.evaluate(() => window.__proofChooserSeen)), "Quoted command opened the chooser.");
      check(fileActions.length === 0, "Quoted command contacted the file resolver.");
    }

    stage = "verify final unsent draft";
    await review.waitFor({ state: "hidden" });
    await expectDraft(expected);
    const confirmed = c.chooser.exitKey === "Enter";
    check(await draft.inputValue() === expected, "Composer changed text outside the expected edit.");
    check(await chip.count() === (confirmed ? 1 : 0), "Wrong number of bound chips.");
    check(confirmed || !fileActions.includes("revalidate"), "Unexpected file revalidation.");
    status = "PASS";
  } catch (error) {
    status = error instanceof InconclusiveSTT ? "INCONCLUSIVE_STT" : "FAIL";
    failure = {
      step: stage,
      name: diagnostic(error?.name ?? "Error", secrets),
      message: diagnostic(error?.message ?? error, secrets),
    };
  } finally {
    if (status === "INCONCLUSIVE_STT") {
      await page.locator(".agent-chat__dictation-status")
        .waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
    }
    const finalComposer = draft ? await draft.inputValue({ timeout: 1_000 }).catch(() => null) : null;
    if (page) {
      screenshot = await page.locator(COMPOSER).screenshot({
        path: join(out, "final.png"), timeout: 5_000,
      }).then(() => "final.png", () => null);
    }
    await browser?.close().catch(() => {});
    if (blockedSends.length > 0) {
      status = "FAIL";
      failure = {
        step: stage, name: "UnexpectedSubmission",
        message: "A chat submission was blocked before reaching the Gateway.",
      };
    }
    if (status === "PASS" && (!screenshot || (c.chooser.opens && !chooserScreenshot))) {
      status = "FAIL";
      failure = {
        step: "capture evidence", name: "MissingScreenshot",
        message: "A required screenshot is missing.",
      };
    }
    const detail = failure ? `${failure.step}: ${failure.name}` : null;
    const save = (name, value) => writeFile(join(out, name), redact(value, secrets), { mode: 0o600 });
    await save("transcript.txt", transcript());
    await save("composer.txt", finalComposer ?? "");
    await save("take.json", JSON.stringify({
      head: h.head, status, detail, stage, error: failure, screenshot, chooserScreenshot,
      gatewayError: gatewayMessage ? diagnostic(gatewayMessage, secrets) : null,
      takeId: take.id, voice: take.voice, clipSha256, qualified: qualified ?? null,
      validInput: qualified ? true : status === "INCONCLUSIVE_STT" ? false : null,
      chatModel: CHAT_MODEL, blockedSends,
      provider: opened?.provider === "openai" ? "openai" : null,
      finalTranscriptParts: finalParts(), finalComposer, fileActions,
    }, null, 2) + "\n");
  }

  console.log(`${clipId}: ${status}${failure ? ` — ${failure.step}: ${failure.name}` : ""}`);
  return {
    id: take.id, status,
    validInput: qualified ? true : status === "INCONCLUSIVE_STT" ? false : null,
    artifact: `${take.id}/take.json`,
  };
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
  const { cases, takes } = JSON.parse(await readFile(join(here, "scenario.json"), "utf8"));
  const uniqueIds = (list) => Array.isArray(list) && list.length > 0 &&
    list.every((item) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)) &&
    new Set(list.map((item) => item.id)).size === list.length;
  check(uniqueIds(cases) && uniqueIds(takes), "Expected unique kebab-case IDs for cases and takes.");

  const { recognizeDictatedFileReferences: recognize } = await import(
    pathToFileURL(join(repo, "ui/src/lib/dictation-file-references.ts")).href
  );

  await mkdir(join(here, "results"), { recursive: true });
  const results = await mkdtemp(join(here, "results", "run-"));
  const ram = await mkdtemp("/dev/shm/openclaw-dictation-");
  const token = randomBytes(32).toString("hex");
  let child, done, exited = false, startError = false;
  const previousTmp = process.env.TMPDIR;
  try {
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
      agents: { defaults: {
        workspace,
        model: { primary: CHAT_MODEL },
        models: { [CHAT_MODEL]: {} },
        voiceModel: "openai/gpt-4o-transcribe",
      } },
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

    const h = { chromium, ramEnv, origin, token, createSession, results, head, recognize };
    for (const c of cases) {
      const out = join(results, c.id);
      await mkdir(out);
      const observed = [];
      for (const take of takes) observed.push(await runTake(c, take, h));
      const passed = observed.filter((t) => t.status === "PASS").length;
      const failed = observed.filter((t) => t.status === "FAIL").length;
      const valid = observed.filter((t) => t.validInput === true).length;
      const status = failed ? "FAIL" : passed ? "PASS" : "INCONCLUSIVE_STT";
      const detail = `${passed}/${observed.length} passed; ${valid} qualified; ${failed} failed`;
      await writeFile(join(out, "case.json"), JSON.stringify({
        head, status, detail, takes: observed,
      }, null, 2) + "\n", { mode: 0o600 });
      if (status !== "PASS") process.exitCode = 1;
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
