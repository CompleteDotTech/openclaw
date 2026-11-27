import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HEAD = "e82b19fb9132d62dd8da3bd516462d3f6739a6ea";
const TREE = "63c9ec8bd4fef5ad8e42136f0f68b0431d0d4d89";
const here = dirname(fileURLToPath(import.meta.url));
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const words = (text) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
const parse = (message) => {
  try { return JSON.parse(message.toString()); } catch { return null; }
};

assert(!process.env.OPENAI_API_KEY, "Run this browser harness without a provider key");
assert(process.argv[2] || process.env.PROOF_PR_DIR, "Missing PR checkout");
assert(process.env.PROOF_GATEWAY_URL, "Missing isolated Gateway URL");
const checkout = resolve(process.argv[2] || process.env.PROOF_PR_DIR);
const gateway = new URL(process.env.PROOF_GATEWAY_URL);
assert(
  gateway.protocol === "http:" && gateway.hostname === "127.0.0.1" &&
    gateway.pathname === "/" && !gateway.username && !gateway.password &&
    !gateway.search && !gateway.hash,
  "Expected a bare loopback HTTP origin",
);
const git = (...args) => execFileSync("git", ["-C", checkout, ...args], {
  encoding: "utf8",
}).trim();
assert.equal(git("rev-parse", "HEAD"), HEAD);
assert.equal(git("rev-parse", "HEAD^{tree}"), TREE);
assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
assert.equal((await json(join(checkout, "dist/build-info.json"))).commit, HEAD);

const [scenario] = (await json(join(here, "scenario.json"))).cases;
const manifest = await json(join(here, "clips/manifest.json"));
assert.equal(manifest.dry_run, false, "Silent dry-run audio is not proof");
const clip = manifest.clips.find((entry) => entry.id === scenario.id);
assert(clip && clip.file === `${scenario.id}.wav`, "Missing scenario WAV");
assert(Number.isFinite(clip.duration_ms) && clip.duration_ms > 1000);
const wav = join(here, "clips", clip.file);
assert.equal(createHash("sha256").update(await readFile(wav)).digest("hex"), clip.sha256);

const results = resolve(process.env.PROOF_RESULTS_DIR || join(here, "results"));
await mkdir(results, { recursive: true });
const out = join(await mkdtemp(join(results, "run-")), scenario.id);
await mkdir(out);
const result = { head: HEAD, tree: TREE, clipSha256: clip.sha256, status: "FAIL" };
const { chromium } = createRequire(join(checkout, "ui/package.json"))("playwright");
const waitFor = async (read, timeout = 20_000) => {
  const end = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 100));
  } while (Date.now() < end);
  throw new Error("Timed out at " + result.step);
};

let browser;
try {
  result.step = "open isolated Gateway";
  const browserEnv = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR", "PLAYWRIGHT_BROWSERS_PATH", "LANG"]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  browser = await chromium.launch({
    env: browserEnv,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wav}%noloop`,
    ],
  });
  const context = await browser.newContext({
    locale: "en-US", colorScheme: "dark", viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
  });
  await context.grantPermissions(["microphone"], { origin: gateway.origin });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);

  const requests = [];
  const replies = new Map();
  const events = [];
  const attemptedSends = [];
  const sendMethods = new Set([
    "chat.send", "sessions.send", "agent", "sessions.dispatch", "sessions.companion.ask",
  ]);
  await page.routeWebSocket((url) => url.host === gateway.host, (client) => {
    const server = client.connectToServer();
    client.onMessage((message) => {
      const frame = parse(message);
      if (frame?.type === "req" && sendMethods.has(frame.method)) {
        attemptedSends.push(frame.method);
        client.send(JSON.stringify({
          type: "res", id: frame.id, ok: false,
          error: { code: "INVALID_REQUEST", message: "Unexpected send in unsent-draft proof" },
        }));
        return;
      }
      if (frame?.type === "req" &&
          ["talk.session.create", "talk.session.close"].includes(frame.method)) {
        requests.push({ id: frame.id, method: frame.method, ...{
          mode: frame.params?.mode, discard: frame.params?.discard,
        } });
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = parse(message);
      if (frame?.type === "res" && requests.some((entry) => entry.id === frame.id)) {
        replies.set(frame.id, {
          ok: frame.ok, id: frame.payload?.transcriptionSessionId, provider: frame.payload?.provider,
        });
      }
      if (frame?.type === "event" && frame.event === "talk.event" &&
          frame.payload?.transcriptionSessionId) {
        events.push(frame.payload);
      }
      client.send(message);
    });
  });

  await page.goto(new URL("/chat/main", gateway));
  await page.waitForFunction(() => window.openclawControlUi?.snapshot().gatewayPhase === "connected");
  const pane = page.locator(
    ".chat-pane-cache__pane--active:visible, .chat-split-view__cell--active openclaw-chat-pane:visible",
  ).first();
  const root = pane.locator(".agent-chat__composer-shell:visible");
  const draft = root.locator('textarea[aria-label="Chat composer"]');
  const button = (name) => root.getByRole("button", { name, exact: true });
  const shot = (name) => page.screenshot({ path: join(out, `${name}.png`), animations: "disabled" });

  result.step = "capture and finalize";
  await draft.fill(scenario.initialDraft);
  await button("Start voice input").hover();
  await page.mouse.down();
  let start;
  try {
    start = await waitFor(() => requests.find(
      (entry) => entry.method === "talk.session.create" && entry.mode === "transcription",
    ));
  } finally {
    await page.mouse.up();
  }
  const admission = await waitFor(() => replies.get(start.id));
  assert(admission.ok && admission.id, "Gateway did not admit transcription");
  result.provider = admission.provider;
  const captureEvents = () => events.filter((event) => event.transcriptionSessionId === admission.id);
  const close = () => captureEvents().find((event) => event.type === "close");
  const audioBytes = () => captureEvents().reduce(
    (sum, event) => sum + (event.type === "inputAudio" ? (event.byteLength ?? 0) : 0), 0,
  );
  // The relay reports 8 kHz μ-law bytes; stop 100 ms before WAV EOF.
  await waitFor(() => close() || audioBytes() >= (clip.duration_ms - 100) * 8, 45_000);
  assert(!close(), "Capture closed before Stop");
  await button("Stop and keep text").click();
  assert.equal((await waitFor(close, 90_000)).reason, "completed");
  const stop = requests.find((entry) => entry.method === "talk.session.close");
  assert(stop && !stop.discard, "Expected Stop and keep, not discard");
  assert(!captureEvents().some((event) => event.type === "error"));
  const transcript = captureEvents()
    .filter((event) => event.type === "transcript" && event.final && event.text?.trim())
    .map((event) => event.text.trim()).join(" ");
  assert(words(transcript) === words(scenario.expectedTranscript), "Final transcript word mismatch");
  const committedDraft = await waitFor(async () => {
    const value = await draft.inputValue();
    return words(value) === words(`${scenario.initialDraft} ${transcript}`) ? value : null;
  });

  result.step = "preview unchanged draft";
  const profiles = root.locator("details.composer-writing-profiles");
  await profiles.locator(":scope > summary").click();
  await profiles.getByText("Review original", { exact: true }).click();
  const original = profiles.getByLabel("Original transcript", { exact: true });
  const retry = profiles.getByRole("button", { name: "Reprocess unsent draft", exact: true });
  const preview = profiles.getByText(/^Preview only\. The original transcript is preserved/);
  const unavailable = profiles.getByText(/^A new preview is unavailable while capture is busy/);
  assert.equal(await original.inputValue(), transcript);
  const captureRequests = requests.length;
  await retry.click();
  await preview.waitFor({ state: "visible" });
  assert.equal(await draft.inputValue(), committedDraft);
  await shot("01-preview");

  result.step = "edit and retry";
  await draft.fill(scenario.editedDraft);
  await retry.click();
  await unavailable.waitFor({ state: "visible" });
  assert.equal(await draft.inputValue(), scenario.editedDraft);
  assert.equal(await original.inputValue(), transcript);
  assert.equal(requests.length, captureRequests, "Retry started or stopped another capture");
  assert.equal(attemptedSends.length, 0, "Preview or retry attempted to send");
  await shot("02-retry-blocked");
  result.stalePreviewVisible = await preview.isVisible();
  assert(!result.stalePreviewVisible, "Retry shows both preview success and preview unavailable");
  result.status = "PASS";
} catch {
  console.error(`Browser proof failed at: ${result.step}`);
  process.exitCode = 1;
} finally {
  try {
    await browser?.close();
  } finally {
    await writeFile(join(out, "case.json"), JSON.stringify(result, null, 2) + "\n");
  }
}
