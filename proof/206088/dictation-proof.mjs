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
const LF = String.fromCharCode(10);
const apiKey = process.env.OPENAI_API_KEY?.trim();
delete process.env.OPENAI_API_KEY;

const REVIEW = ".composer-file-references__review";
const CHIP = ".chat-composer-file-reference";
const COMPOSER = ".agent-chat__composer-shell";
const DRAFT = COMPOSER + ' textarea[aria-label="Chat composer"]';
const CHAT_MODEL = "openai/gpt-5.4-mini";
const SEND_METHODS = new Set(["chat.send", "sessions.send", "agent"]);
const VISUAL_CASE = "contractions";
const VISUAL_SURFACE = ".chat-main__conversation-column";
const SEND_BUTTON = COMPOSER + " .chat-send-btn--send";
const CONVERT = "Convert file references to plain text";
const REFUSAL = "Convert file references to plain text before sending. This conversation cannot deliver their object identities.";
const VIEWPORT = { width: 1440, height: 1000 };
const FILE_REPLIES = { capabilities: "ready", search: "matches", revalidate: "validated" };

function redact(text, secrets) {
  let safe = String(text);
  for (const secret of secrets) {
    safe = safe.replaceAll(secret, "[redacted]");
    safe = safe.replaceAll(encodeURIComponent(secret), "[redacted]");
  }
  return safe;
}

// Capture only the isolated fixture's conversation column; no browser chrome,
// settings, failed takes, traces, raw messages or request/response dumps.
async function captureFrame(page, target, secrets, expectedDraft, draft) {
  const surface = page.locator(VISUAL_SURFACE);
  await surface.waitFor();
  await target.waitFor();
  const measure = () => Promise.all([surface.boundingBox(), target.boundingBox()]);
  const presentation = await surface.evaluate(async (element, newline) => {
    await document.fonts.ready;
    await new Promise((finish) => requestAnimationFrame(() => requestAnimationFrame(finish)));
    return {
      scrollX,
      scrollY,
      theme: document.documentElement.dataset.themeMode ?? getComputedStyle(document.documentElement).colorScheme,
      rendered: [element.innerText, ...Array.from(
        element.querySelectorAll("textarea, input:not([type=hidden]), [contenteditable=true]"),
        (field) => field.value ?? field.textContent,
      )].join(newline),
    };
  }, "\x0a");
  check(presentation.scrollX === 0 && presentation.scrollY === 0, "The proof viewport scrolled.");
  check(await draft.inputValue() === expectedDraft, "The draft changed before capture.");
  const safe = presentation.rendered;
  check(redact(safe, secrets) === safe &&
    !/\b(?:https?|wss?):|\bwww\.|\b(?:authorization|cookie|set-cookie)\s*:|\b(?:Bearer|Basic)\s+[A-Za-z0-9_.-]{12,}|\bsk-[a-z0-9_-]{8,}|(?:^|[\s"'(])(?:\/(?:dev|home|root|run|tmp|workspace|mnt|var|etc)\/|[a-z]:\\)|[\w.+-]+@[\w.-]+\.[a-z]{2,}/im.test(safe),
    "Potentially sensitive text in the capture surface.");
  const before = await measure();
  const [outer, inner] = before;
  check(outer && inner, "Capture surface or target is missing.");
  const x = Math.ceil(outer.x), y = Math.ceil(outer.y);
  const clip = { x, y, width: Math.floor(outer.x + outer.width) - x,
    height: Math.floor(outer.y + outer.height) - y };
  const rect = { x: inner.x - x, y: inner.y - y, width: inner.width, height: inner.height };
  check(x >= 0 && y >= 0 && clip.width > 0 && clip.height > 0 &&
    x + clip.width <= VIEWPORT.width && y + clip.height <= VIEWPORT.height &&
    rect.x >= 0 && rect.y >= 0 &&
    rect.x + rect.width <= clip.width && rect.y + rect.height <= clip.height,
    "Capture surface or target is clipped.");
  const png = await page.screenshot({
    clip, animations: "disabled", caret: "hide", scale: "css", timeout: 5_000,
    mask: [surface.locator("img, video, canvas, iframe, .context-usage")], maskColor: "#778899",
  });
  check(JSON.stringify(await measure()) === JSON.stringify(before) &&
    await draft.inputValue() === expectedDraft, "Capture geometry or draft changed during capture.");
  return { clip, rect, theme: presentation.theme, png };
}

// STT can vary on identical audio. Only qualified synthetic text can become pixels;
// transcript text and digests of it are never written to the proof bundle.
function safeFixtureTranscript(raw) {
  return raw.length <= 240 && /^[\p{L}\p{M}\p{N} .,'’‘“”"!?;:…/()\-]+$/u.test(raw) &&
    !/(?:^|\s)\/|:\/\/|\bwww\./i.test(raw);
}

async function saveVisuals(out, frames, browser, rasterize) {
  const saved = [];
  for (const [stage, { clip, rect, png, label }] of frames) {
    const clean = `${stage}-clean.png`;
    const item = { stage, clean, clip };
    if (label) {
      const spec = {
        viewport: { width: clip.width, height: clip.height }, scale: 1,
        annotations: [{ kind: "outline", rect, text: label,
          labelAt: { x: 12, y: Math.max(12, rect.y - 52) }, color: "#7654a5" }],
      };
      const annotated = await rasterize(browser, { ...spec, image: png });
      item.annotated = `${stage}-annotated.png`;
      item.measurements = `${stage}-measurements.json`;
      await writeFile(join(out, item.annotated), annotated, { mode: 0o600 });
      await writeFile(join(out, item.measurements), JSON.stringify(spec, null, 2) + LF, { mode: 0o600 });
    }
    await writeFile(join(out, clean), png, { mode: 0o600 });
    saved.push(item);
  }
  return saved;
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

// Qualify what the parser decoded, not what the resolver might find.
function namesFixture(query, expected) {
  const spoken = query.toLowerCase();
  const fixture = expected.toLowerCase();
  if (spoken === fixture) return true;
  return spoken.startsWith(fixture) && /^[.,!?;:…]+$/u.test(spoken.slice(fixture.length));
}

function qualify(raw, c, recognize) {
  const parse = (s) => recognize(s, { locale: "en-US", literal: false, commandMode: false });
  const plan = parse(raw);
  function intended(parsed, offset) {
    if (parsed.status !== "ready" || parsed.commands.length !== 1) return null;
    const cmd = parsed.commands[0];
    const start = cmd.start + offset, end = cmd.end + offset;
    if (cmd.kind !== "file" || !namesFixture(cmd.query, c.file) ||
        words(raw.slice(0, start)) !== words(c.before) ||
        words(raw.slice(end)) !== words(c.after)) return null;
    return { start, end, query: cmd.query, recognizedCommands: plan.commands.length };
  }
  if (!c.singleQuoted) return intended(plan, 0);

  // Locate an actual single-quoted span, not a contraction. Parse its contents
  // separately so failure to protect the original span doesn't disqualify it.
  const quotes = /(?<![\p{L}\p{M}\p{N}])'(?:[^'\x0a]|(?<=[\p{L}\p{M}\p{N}])'(?=[\p{L}\p{M}\p{N}]))*'(?![\p{L}\p{M}\p{N}])|‘(?:[^’\x0a]|(?<=[\p{L}\p{M}\p{N}])’(?=[\p{L}\p{M}\p{N}]))*’(?![\p{L}\p{M}\p{N}])/gu;
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
  const out = join(h.results, c.id, take.id, h.variant);
  await mkdir(out, { recursive: true, mode: 0o700 });
  const visual = c.id === VISUAL_CASE;
  const frames = new Map();
  let stage = "create fixture session";
  let status = "FAIL", failure = null, captures = [];
  let browser, page, draft, connectId, createId, closeId, opened, closeOK, firstAudioAt;
  let gatewayErrorSeen = false, clipSha256, qualified, raw;
  let refusedBeforeInterceptor = false, convertedToPlainText = false;
  const events = [], fileActions = [], blockedSends = [];
  const pendingFileRequests = new Map(), successfulFileActions = new Set();
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
        "--disable-partial-raster",
        "--disable-gpu-rasterization",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${clip}%noloop`,
      ],
    });
    const context = await browser.newContext({
      locale: "en-US", viewport: VIEWPORT, deviceScaleFactor: 1,
      colorScheme: "light", reducedMotion: "reduce",
      permissions: ["microphone"], serviceWorkers: "block",
    });
    page = await context.newPage();
    page.setDefaultTimeout(15_000);

    const origin = new URL(h.origin);
    // Browser egress is limited to this isolated Gateway and its static reads.
    // Gateway-to-STT traffic is separate; never forward a UI turn submission.
    await page.route("**/*", (route) => {
      const request = route.request();
      return new URL(request.url()).origin === origin.origin &&
        ["GET", "HEAD"].includes(request.method()) ? route.continue() : route.abort();
    });
    await page.routeWebSocket(() => true, (socket) => {
      if (new URL(socket.url()).host !== origin.host) {
        void socket.close();
        return;
      }
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
          if (f.method === "sessions.files.references") {
            const action = f.params?.action;
            fileActions.push(action);
            if (Object.hasOwn(FILE_REPLIES, action)) pendingFileRequests.set(f.id, action);
          }
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
          if (!f.ok && [connectId, createId, closeId].includes(f.id)) gatewayErrorSeen = true;
          const action = pendingFileRequests.get(f.id);
          if (action) {
            pendingFileRequests.delete(f.id);
            if (f.ok === true && p?.status === FILE_REPLIES[action]) successfulFileActions.add(action);
          }
        }
        if (f?.type === "event" && f.event === "talk.event" && p?.transcriptionSessionId) {
          if (p.type === "error") gatewayErrorSeen = true;
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

    const optIn = page.getByRole("checkbox", {
      name: "English file-reference commands for this session's local workspace", exact: true,
    });
    if (h.variant === "candidate") {
      stage = "wait for actionable file-reference opt-in";
      await optIn.and(page.locator(":enabled")).waitFor({ state: "visible", timeout: 30_000 });
      check(!(await optIn.isChecked()), "File-reference commands must be off in a fresh session.");
      stage = "click the file-reference opt-in";
      await optIn.click();
      stage = "wait for file-reference opt-in to settle checked";
      await optIn.and(page.locator(':enabled:checked:not([aria-busy="true"])'))
        .waitFor({ state: "visible", timeout: 30_000 });
      stage = "wait for the opted-in file-reference owner";
      await page.getByRole("checkbox", {
        name: "Literal mode: keep command-like words as text", exact: true,
      }).waitFor();
    } else {
      stage = "verify main has no file-reference opt-in";
      check(await optIn.count() === 0, "Main unexpectedly exposes the candidate opt-in.");
    }
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
    raw = transcript();
    qualified = qualify(raw, c, h.recognize);
    if (!qualified) throw new InconclusiveSTT(c.singleQuoted
      ? "STT did not supply the intended command within actual single quotes."
      : "STT did not supply the intended parseable command and surrounding words.");
    check(h.variant === "main" || !c.singleQuoted || qualified.recognizedCommands === 0,
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
    const capture = async (name, target, value, label) => {
      check(safeFixtureTranscript(raw), "Qualified transcript is not safe for visual evidence.");
      const frame = await captureFrame(page, target, secrets, value, draft);
      check(!frames.size || frames.values().next().value.theme === frame.theme, "Capture theme changed within a take.");
      frames.set(name, { ...frame, label });
    };

    if (h.variant === "main") {
      stage = "verify baseline plain-text draft";
      check(!(await page.evaluate(() => window.__proofChooserSeen)) &&
        await chip.count() === 0 && fileActions.length === 0,
        "Baseline unexpectedly used file-reference review.");
      stage = "capture baseline plain-text draft";
      const editor = page.locator(COMPOSER + " .agent-chat__composer-combobox");
      await capture("plain-transcript", editor, raw, "Dictation stays as ordinary text");
    } else if (c.chooser.opens) {
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
      check(successfulFileActions.has("capabilities") && successfulFileActions.has("search"),
        "Candidate selection has no successful real Gateway metadata receipts.");
      if (visual) {
        stage = "inspect authorized path and workspace";
        const option = review.locator(".composer-file-references__candidate")
          .filter({ has: page.getByRole("radio", { name: c.file, exact: true }) });
        const details = option.locator("summary");
        await details.click();
        await option.getByText("fixture-workspace", { exact: true }).waitFor();
        check((await option.locator("code").innerText()).trim() === c.file, "Path disclosure did not match the fixture.");
        stage = "capture authorized selection";
        await capture("authorized-selection", option, raw, "Selected workspace file, before insertion");
      }

      if (c.chooser.exitKey === "Enter") {
        stage = "confirm the bound reference by keyboard";
        await tabTo(page, review.getByRole("button", { name: "Insert bound reference", exact: true }));
        await page.keyboard.press("Enter");
        const label = `@${c.file}`;
        expected = raw.slice(0, qualified.start) + label + raw.slice(qualified.end);
        await chip.waitFor();
        check(await chip.textContent() === label, "Bound chip has the wrong label.");
        check(successfulFileActions.has("revalidate"), "Confirm did not receive a successful Gateway revalidation.");
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
    const confirmed = h.variant === "candidate" && c.chooser.exitKey === "Enter";
    const bindingCount = async () => {
      const refs = JSON.parse((await draft.getAttribute("data-composer-file-references")) ?? "[]");
      check(Array.isArray(refs), "Composer binding metadata is not an array.");
      return refs.length;
    };
    check(await draft.inputValue() === expected, "Composer changed text outside the expected edit.");
    check(await chip.count() === (confirmed ? 1 : 0), "Wrong number of bound chips.");
    check(confirmed || !fileActions.includes("revalidate"), "Unexpected file revalidation.");

    if (visual && confirmed) {
      const convert = page.locator(COMPOSER).getByRole("button", { name: CONVERT, exact: true });
      const send = page.locator(SEND_BUTTON);
      const refusal = page.locator(VISUAL_SURFACE).getByText(REFUSAL, { exact: true });
      stage = "capture confirmed unsent reference";
      await convert.waitFor();
      await until(async () => await bindingCount() === 1, "one binding stored in the editor");
      await capture("bound-draft", chip, expected);

      stage = "verify product refuses Send before interception";
      check(!(await refusal.isVisible()) && blockedSends.length === 0, "Send proof did not start cleanly.");
      await send.click();
      await refusal.waitFor();
      check(blockedSends.length === 0 && await draft.inputValue() === expected &&
        await bindingCount() === 1 && await chip.count() === 1,
        "Refusal did not preserve the bound draft before the send interceptor.");
      refusedBeforeInterceptor = true;
      stage = "capture product refusal";
      await capture("send-refused", refusal, expected);

      stage = "convert to ordinary text without sending";
      await convert.click();
      await convert.waitFor({ state: "hidden" });
      await chip.waitFor({ state: "hidden" });
      await until(async () => await bindingCount() === 0, "binding metadata removed");
      await until(() => send.isEnabled(), "ordinary Send enabled");
      check(await draft.inputValue() === expected && blockedSends.length === 0,
        "Conversion changed the visible draft or attempted submission.");
      convertedToPlainText = true;
      stage = "capture converted unsent text";
      const editor = page.locator(COMPOSER + " .agent-chat__composer-combobox");
      await capture("converted-draft", editor, expected);
    }

    if (frames.size) {
      stage = "write fixed-name visual evidence";
      check(blockedSends.length === 0, "A submission reached the interceptor.");
      captures = await saveVisuals(out, frames, browser, h.rasterize);
    }
    status = "PASS";
  } catch (error) {
    status = error instanceof InconclusiveSTT ? "INCONCLUSIVE_STT" : "FAIL";
    failure = { step: stage, code: error instanceof InconclusiveSTT ? "STT_MISS" : "ASSERTION_OR_RUNTIME" };
  } finally {
    await browser?.close().catch(() => {});
    if (blockedSends.length > 0) {
      status = "FAIL";
      failure = { step: stage, code: "UNEXPECTED_SUBMISSION" };
    }
  }

  const validInput = qualified ? true : status === "INCONCLUSIVE_STT" ? false : null;
  const result = {
    variant: h.variant, head: h.head, status, failure, clipSha256, validInput, gatewayErrorSeen,
    providerCompleted: closeOK === true && relayEvents().some((event) =>
      event.type === "close" && event.reason === "completed") && !gatewayErrorSeen,
    interceptedSendCount: blockedSends.length, refusedBeforeInterceptor, convertedToPlainText,
    successfulFileActions: [...successfulFileActions], captures,
  };
  await writeFile(join(out, "take.json"), JSON.stringify(result, null, 2) + LF, { mode: 0o600 });
  console.log(`${clipId}/${h.variant}: ${status}${failure ? ` — ${failure.step}: ${failure.code}` : ""}`);
  return {
    ...result,
    artifact: `${take.id}/${h.variant}/take.json`,
    // Pairing metadata stays process-local; no transcript is written to disk.
    visual: status === "PASS" && frames.size ? { raw, theme: frames.values().next().value.theme } : null,
  };
}

async function withGateway({ repo, ram, chromium, variant, results, head, recognize, rasterize }, run) {
  const launcher = join(repo, "openclaw.mjs");
  const uiRoot = join(repo, "dist", "control-ui");
  const token = randomBytes(32).toString("hex");
  let child, done, exited = false, startError = false;
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
  try {
    const socket = createServer().listen(0, "127.0.0.1");
    await once(socket, "listening");
    const { port } = socket.address();
    await new Promise((resolveClose, reject) => socket.close((err) =>
      err ? reject(err) : resolveClose()));
    const origin = new URL(`http://127.0.0.1:${port}`).origin;
    const workspace = join(ram, "fixture-workspace");
    await mkdir(join(workspace, "src"), { recursive: true });
    for (const path of ["src/auth.ts", "notes", "checklist"]) {
      await writeFile(join(workspace, path), "Synthetic proof fixture" + LF);
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

    await run({ variant, chromium, ramEnv, origin, token, createSession, results, head, recognize, rasterize });
  } finally {
    if (child?.pid && !exited) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      await Promise.race([done, sleep(5_000, undefined, { ref: false })]);
      if (!exited) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
        await done;
      }
    }
  }
}

async function main() {
  check(apiKey, "Set OPENAI_API_KEY only in the authorized live proof run step.");
  check(process.platform === "linux" && (await statfs("/dev/shm")).type === 0x01021994,
    "Expected Linux tmpfs at /dev/shm.");
  check((await readFile("/proc/swaps", "utf8")).trim().split(LF).length === 1,
    "Swap is enabled. Turn it off on this disposable runner before using the secret.");
  check(process.env.PROOF_PR_DIR && process.env.PROOF_RESULTS_DIR,
    "Expected workflow-provided PROOF_PR_DIR and PROOF_RESULTS_DIR.");
  const mainPath = JSON.parse(process.env.PROOF_CHECKOUTS ?? "{}").main;
  check(typeof mainPath === "string" && mainPath.length > 0,
    "Configure a built PROOF_CHECKOUTS.main for the visual comparison.");
  const candidate = resolve(process.env.PROOF_PR_DIR);
  const baseline = resolve(mainPath);
  if (process.argv[2]) {
    check(resolve(process.argv[2]) === candidate, "The positional checkout must agree with PROOF_PR_DIR.");
  }
  const headFor = (repo) => execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const heads = { main: headFor(baseline), candidate: headFor(candidate) };
  check(Object.values(heads).every((head) => /^[0-9a-f]{40}$/.test(head)) && heads.main !== heads.candidate,
    "Expected distinct, valid main and candidate revisions.");
  for (const repo of [baseline, candidate]) await access(join(repo, "dist", "control-ui", "index.html"));

  const { cases, takes } = JSON.parse(await readFile(join(here, "scenario.json"), "utf8"));
  const uniqueIds = (list) => Array.isArray(list) && list.length > 0 &&
    list.every((item) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)) &&
    new Set(list.map((item) => item.id)).size === list.length;
  check(uniqueIds(cases) && uniqueIds(takes), "Expected unique kebab-case IDs for cases and takes.");
  const visualCase = cases.find((c) => c.id === VISUAL_CASE);
  check(visualCase?.file === "src/auth.ts" && visualCase.chooser?.opens && visualCase.chooser.exitKey === "Enter",
    "Expected the synthetic contractions/confirmation case for visual pairing.");
  const { recognizeDictatedFileReferences: recognize } = await import(
    pathToFileURL(join(candidate, "ui/src/lib/dictation-file-references.ts")).href
  );
  // The frame helper imports Vitest and requires its runner. The standalone
  // script uses Playwright for the clean frame and the shared annotation renderer.
  const { rasterizeProofAnnotations: rasterize } = await import(
    pathToFileURL(join(candidate, "ui/src/test-helpers/proof-annotations.ts")).href
  );
  const parent = resolve(process.env.PROOF_RESULTS_DIR);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const results = await mkdtemp(join(parent, "run-"));
  const ram = await mkdtemp("/dev/shm/openclaw-dictation-");
  const previousTmp = process.env.TMPDIR;
  try {
    process.env.TMPDIR = ram;
    const { chromium } = createRequire(join(candidate, "ui", "package.json"))("playwright");
    const baselineTakes = new Map();
    const runLane = async (variant, repo, run) => {
      const laneRam = join(ram, variant);
      await mkdir(laneRam, { mode: 0o700 });
      await withGateway({
        variant, repo, ram: laneRam, chromium, results, head: heads[variant], recognize, rasterize,
      }, run);
    };
    let mainLaneFailed = false;
    try {
      await runLane("main", baseline, async (h) => {
        for (const take of takes) baselineTakes.set(take.id, await runTake(visualCase, take, h));
      });
    } catch {
      mainLaneFailed = true;
      console.error("Main comparison lane failed to set up, complete or clean up.");
    }
    await runLane("candidate", candidate, async (h) => {
      for (const c of cases) {
        const out = join(results, c.id);
        await mkdir(out, { recursive: true, mode: 0o700 });
        const observed = [], pairs = [];
        for (const take of takes) {
          const { visual, ...after } = await runTake(c, take, h);
          observed.push({ id: take.id, ...after });
          if (c !== visualCase) continue;
          const before = baselineTakes.get(take.id);
          const sameWav = Boolean(before?.clipSha256 && before.clipSha256 === after.clipSha256);
          const bothPassed = before?.status === "PASS" && after.status === "PASS";
          const matchedGeometry = Boolean(bothPassed && before.visual?.theme === visual?.theme &&
            before.captures.length === 1 && after.captures.length === 4 && after.captures.every(({ clip }) =>
              JSON.stringify(clip) === JSON.stringify(before.captures[0].clip)));
          const pairStatus = !before || before.status === "FAIL" || after.status === "FAIL" ||
            !sameWav || (bothPassed && !matchedGeometry) ? "FAIL" :
            bothPassed ? "PASS" : "INCONCLUSIVE_STT";
          pairs.push({
            takeId: take.id, status: pairStatus, sameWav, matchedGeometry,
            sameFinalText: bothPassed ? before.visual.raw === visual.raw : null,
            mainStatus: before?.status ?? "NOT_RUN", candidateStatus: after.status,
            before: before?.artifact ?? null, after: after.artifact,
          });
        }
        const passed = observed.filter((t) => t.status === "PASS").length;
        const failed = observed.filter((t) => t.status === "FAIL").length;
        const valid = observed.filter((t) => t.validInput === true).length;
        const status = failed ? "FAIL" : passed ? "PASS" : "INCONCLUSIVE_STT";
        const detail = `${passed}/${observed.length} passed; ${valid} qualified; ${failed} failed`;
        await writeFile(join(out, "case.json"), JSON.stringify({
          head: heads.candidate, status, detail, takes: observed,
        }, null, 2) + LF, { mode: 0o600 });
        if (status !== "PASS") process.exitCode = 1;
        if (c !== visualCase) continue;
        const paired = pairs.filter((pair) => pair.status === "PASS");
        const preferred = paired.find((pair) => pair.sameFinalText) ?? paired[0];
        const pairStatus = mainLaneFailed || pairs.some((pair) => pair.status === "FAIL") ? "FAIL" :
          preferred ? "PASS" : "INCONCLUSIVE_STT";
        await writeFile(join(out, "comparison.json"), JSON.stringify({
          heads, status: pairStatus, preferredTakeId: preferred?.takeId ?? null, mainLaneFailed,
          pairs, viewport: VIEWPORT, scale: 1, syntheticWav: true, liveStt: true,
          deniedGatewayAuthorization: "NOT_RUN_NO_SUPPORTED_RESTRICTED_IDENTITY_FIXTURE",
          liveChatDelivery: "NOT_RUN_SEND_INTERLOCK_ACTIVE",
        }, null, 2) + LF, { mode: 0o600 });
        console.log(`Visual comparison: ${pairStatus}; ${paired.length}/${pairs.length} comparable takes.`);
        if (pairStatus !== "PASS") process.exitCode = 1;
      }
    });
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    await rm(ram, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof ProofError ? error.message : "Harness setup or cleanup failed.");
  process.exitCode = 1;
}
