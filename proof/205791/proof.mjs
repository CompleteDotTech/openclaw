import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Script the upstream WebSocket, not the Gateway events or browser client. The
// Gateway, bundled Deepgram adapter, relay, browser UI and editor run normally.
const here = dirname(fileURLToPath(import.meta.url));
assert.ok(process.argv[2], 'Usage: node proof.mjs <built checkout> [WAV override]');
const checkout = resolve(process.argv[2]);
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
if (process.env.SHA) assert.equal(head, process.env.SHA, 'run-list checkout SHA');
const { cases: [fixture], takes: [take] } = JSON.parse(await readFile(join(here, 'scenario.json'), 'utf8'));
const wav = resolve(process.argv[3] ?? join(here, 'clips', fixture.id + '--' + take.id + '.wav'));
const [early, late] = fixture.segments.map(({ text }) => text);
const { finalDelayMs, terminalDelayMs, markdown } = fixture.expected;
const draft = 'Keep this draft until review';
const { chromium } = createRequire(join(checkout, 'ui/package.json'))('playwright');
const { WebSocketServer } = createRequire(join(checkout, 'package.json'))('ws');
const dir = await mkdtemp(join(tmpdir(), 'dictation-streaming-proof-'));
const artifacts = resolve(process.env.PROOF_RESULTS_DIR || join(here, 'results'));
await mkdir(artifacts, { recursive: true });
const run = await mkdtemp(join(artifacts, 'run-'));
const out = join(run, fixture.id + '--' + take.id);
await mkdir(out);

const portReservation = createServer().listen(0, '127.0.0.1');
await once(portReservation, 'listening');
const port = portReservation.address().port;
await new Promise((done) => portReservation.close(done));
const origin = 'http://127.0.0.1:' + port;
const provider = new WebSocketServer({ host: '127.0.0.1', port: 0 });
let bytes = 0;
let finalTimer;
let finalizedAt;
let sentAt;
let providerPath;
let gateway;
let exited;
let browser;
let page;
let receipt;
let dead = false;
let gatewayLog = '';
function result(ws, text, fromFinalize) {
  ws.send(JSON.stringify({ type: 'Results', is_final: true, speech_final: !fromFinalize,
    from_finalize: fromFinalize, channel: { alternatives: [{ transcript: text }] } }));
}
provider.on('connection', (ws, request) => {
  providerPath = new URL(request.url, 'http://127.0.0.1').pathname;
  ws.on('message', (data, binary) => {
    if (binary) {
      if (!bytes) result(ws, early, false);
      bytes += data.length;
    } else if (JSON.parse(data.toString()).type === 'Finalize' && finalizedAt === undefined) {
      finalizedAt = performance.now();
      finalTimer = setTimeout(() => {
        sentAt = performance.now();
        result(ws, late, true);
      }, finalDelayMs);
      // The fixture never closes the socket early; the production relay emits
      // the terminal close when its own five-second drain expires.
    }
  });
});

async function until(label, ready, timeout = 8000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    if (await ready()) return;
    await delay(25);
  }
  throw new Error('Timed out: ' + label);
}

try {
  await once(provider, 'listening');
  const providerRoot = 'http://127.0.0.1:' + provider.address().port + '/v1';
  const config = join(dir, 'openclaw.json');
  await writeFile(config, JSON.stringify({
    gateway: { mode: 'local', bind: 'loopback', auth: { mode: 'none' }, controlUi: { enabled: true, root: join(checkout, 'dist/control-ui') } },
    // Keep New Session out of model setup without invoking inference. Any send is a failure.
    agents: { defaults: { workspace: join(dir, 'workspace'), model: { primary: 'fixture/no-inference' } } },
    models: { providers: { fixture: { baseUrl: providerRoot, apiKey: 'fixture-only', api: 'openai-completions',
      models: [{ id: 'no-inference', name: 'Fixture (not invoked)' }] } } },
    logging: { file: join(dir, 'gateway.log') },
    plugins: { allow: ['deepgram'], entries: { deepgram: { enabled: true } } },
  }), { mode: 0o600 });
  const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: process.env.TMPDIR,
    XDG_CONFIG_HOME: join(dir, 'config'), XDG_CACHE_HOME: join(dir, 'cache'),
    OPENCLAW_HOME: dir, OPENCLAW_STATE_DIR: join(dir, 'state'), OPENCLAW_CONFIG_PATH: config,
    OPENCLAW_DISABLE_BONJOUR: '1', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_SKIP_CRON: '1',
    DEEPGRAM_API_KEY: 'fixture-only', DEEPGRAM_BASE_URL: providerRoot };
  gateway = spawn(process.execPath, [join(checkout, 'openclaw.mjs'), 'gateway', 'run', '--port', String(port)],
    { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  exited = new Promise((done) => {
    const finish = () => { dead = true; done(); };
    gateway.once('error', finish);
    gateway.once('close', finish);
  });
  for (const stream of [gateway.stdout, gateway.stderr]) {
    stream.on('data', (chunk) => { gatewayLog = (gatewayLog + chunk.toString()).slice(-9000); });
  }
  await until('isolated built Gateway', async () => {
    assert.ok(!dead, 'isolated Gateway exited');
    const reply = await fetch(origin + '/startupz', { signal: AbortSignal.timeout(1000) }).catch(() => null);
    return reply?.ok && (await reply.json()).status === 'started';
  }, 90_000);

  // Preserve a supplied Fontconfig override. On standard CI, Chromium uses the installed system fonts.
  browser = await chromium.launch({ env: { PATH: process.env.PATH, HOME: dir, TMPDIR: process.env.TMPDIR, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH, FONTCONFIG_FILE: process.env.FONTCONFIG_FILE }, args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--use-file-for-fake-audio-capture=' + wav,
  ] });
  page = await browser.newPage({ permissions: ['microphone'] });
  page.setDefaultTimeout(12_000);
  await page.addInitScript(() => {
    const proof = { events: [], firstReviewAt: null };
    window.dictationProof = proof;
    window.WebSocket = class extends window.WebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('message', ({ data }) => {
          if (typeof data !== 'string') return;
          const msg = JSON.parse(data);
          if (msg.event !== 'talk.event') return;
          const kind = msg.payload?.talkEvent?.type;
          if (['input.audio.committed', 'transcript.done', 'session.closed'].includes(kind)) {
            proof.events.push({ kind, at: performance.now(), text: msg.payload.text, reason: msg.payload.reason });
          }
        });
      }
    };
    new MutationObserver(() => {
      if (proof.firstReviewAt === null && document.querySelector('fieldset.dictation-formatting')?.checkVisibility()) {
        proof.firstReviewAt = performance.now();
      }
    }).observe(document, { childList: true, attributes: true, subtree: true });
  });
  let sends = 0;
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      const msg = JSON.parse(payload.toString());
      if (['chat.send', 'sessions.dispatch', 'sessions.send', 'sessions.create', 'agent', 'agent.run', 'sessions.companion.ask'].includes(msg.method)) sends++;
    });
  });
  const button = (host, name) => host.getByRole('button', { name, exact: true });
  await page.goto(origin + '/new');
  const field = page.locator('.new-session-page__message');
  const shell = page.locator('.new-session-page__composer');
  const start = button(shell, 'Start session');
  await field.fill(draft);
  await until('connected composer', () => start.isEnabled({timeout: 1000}).catch(() => false), 15_000);
  await button(shell, 'Microphone input').focus();
  await page.keyboard.press('Enter');
  const explicit = page.getByRole('menuitemradio', { name: 'Interpret explicit structure (English)', exact: true });
  await explicit.click();
  await explicit.waitFor();
  assert.equal(await explicit.getAttribute('aria-checked'), 'true');
  await page.keyboard.press('Escape');
  await field.selectText();
  await shell.locator('.chat-send-btn--voice:visible').first().click();
  const minBytes = Math.floor((await readFile(wav)).length / 12) - 1600; // 48kHz PCM to 8kHz μ-law
  await until('Chrome WAV audio at the provider and early transcript at the browser', async () =>
    bytes >= Math.max(8000, minBytes) && await page.evaluate(
      (text) => window.dictationProof.events.some((event) => event.kind === 'transcript.done' && event.text === text), early));
  assert.equal(providerPath, '/v1/listen');
  await button(page, 'Finish and review').click();
  await until('provider Finalize from the production relay', () => finalizedAt !== undefined);
  assert.equal(await start.isDisabled(), true);
  await field.press('Enter');
  assert.equal(await field.inputValue(), draft);
  const review = page.getByRole('group', { name: 'Review dictation', exact: true });
  await review.waitFor();
  receipt = await page.evaluate(() => window.dictationProof);
  const committed = receipt.events.find((event) => event.kind === 'input.audio.committed');
  const final = receipt.events.find((event) => event.kind === 'transcript.done' && event.text === late);
  const closed = receipt.events.find((event) => event.kind === 'session.closed');
  assert.ok(committed && final && closed, 'review opened without both the 4.5-second final and terminal close: ' + JSON.stringify(receipt));
  assert.equal(closed.reason, 'completed');
  assert.notEqual(receipt.firstReviewAt, null, 'did not observe the review fieldset open');
  const times = { providerFinalMs: sentAt - finalizedAt, finalAtBrowserMs: final.at - committed.at,
    terminalAtBrowserMs: closed.at - committed.at, reviewAfterTerminalMs: receipt.firstReviewAt - closed.at };
  assert.ok(times.providerFinalMs >= finalDelayMs - 10 && times.providerFinalMs < terminalDelayMs, JSON.stringify(times));
  // The 500 ms gap distinguishes terminal close from the final transcript.
  assert.ok(final.at < closed.at && times.terminalAtBrowserMs >= terminalDelayMs - 75, JSON.stringify(times));
  assert.ok(times.reviewAfterTerminalMs >= 0, JSON.stringify(times));
  assert.equal(await field.inputValue(), draft);
  await writeFile(join(out, 'relay-timing.json'), JSON.stringify({head, bytes, ...times}, null, 2));
  const markers = await review.getByRole('checkbox').all();
  assert.equal(markers.length, 2);
  for (const marker of markers) {
    await marker.focus();
    await page.keyboard.press('Space');
  }
  await button(review, 'Interpret selected commands').click();
  const items = review.getByRole('region', { name: 'Semantic preview' }).locator('ul > li');
  await until('both list items in Explicit preview', async () => JSON.stringify(await items.allTextContents()) === '["milk","eggs"]');
  const apply = button(review, 'Use formatted text');
  await apply.focus();
  assert.equal(await apply.isEnabled(), true, 'Apply lost its captured target when focused');
  await page.keyboard.press('Enter');
  await until('formatted Markdown applied to the editor', async () => await field.inputValue() === markdown, 3000);
  await field.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await until('native Undo restores the pre-recording draft', async () => await field.inputValue() === draft, 3000);
  assert.equal(sends, 0);
  const facts = { status: 'PASS', head, bytes, ...times, sends, fixture: 'scripted streaming STT, production Gateway relay and UI' };
  await writeFile(join(out, 'case.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify(facts));
} catch (error) {
  await writeFile(join(out, 'case.json'), JSON.stringify({ status: 'FAIL', head, detail: error.message, bytes }, null, 2));
  if (page) console.error({url: page.url(), buttons: await page.getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') || button.textContent?.trim()).filter(Boolean).slice(-30)).catch(() => []),
    draft: await page.locator('.new-session-page__message').inputValue({timeout: 500}).catch(() => null),
    reviewStatus: await page.locator('fieldset.dictation-formatting [role=status]').allTextContents().catch(() => []),
    timing: receipt && { firstReviewAt: receipt.firstReviewAt, events: receipt.events.map(({ kind, at }) => ({ kind, at })) }});
  if (dead || !browser) console.error(gatewayLog);
  throw error;
} finally {
  clearTimeout(finalTimer);
  await browser?.close();
  if (gateway && !dead) {
    gateway.kill('SIGTERM');
    await Promise.race([exited, delay(8000, undefined, { ref: false })]);
    if (!dead) gateway.kill('SIGKILL');
    await exited;
  }
  for (const socket of provider.clients) socket.terminate();
  await new Promise((done) => provider.close(done));
  await rm(dir, { recursive: true, force: true });
}
