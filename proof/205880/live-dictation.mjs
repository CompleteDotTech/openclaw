import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statfsSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const chatModel = 'openai/gpt-5.4-mini', sttModel = 'gpt-4o-transcribe';
const key = process.env.OPENAI_API_KEY?.trim();
delete process.env.OPENAI_API_KEY;
const words = (s) =>
  s.normalize('NFKC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu)?.join(' ') ?? '';
const redact = (s) => (key ? s.replaceAll(key, '[redacted]') : s)
  .replace(/\b(?:sk|ek)-[\w-]+|\bBearer\s+\S+|\beyJ[\w-]+\.[\w-]+\.[\w-]+|\b(?:api[_-]?key|[\w-]*token|authorization)\s*[:=]\s*\S+/gi, '[redacted]');

class CheckError extends Error {}
class PageAlertError extends CheckError {}
const diagnostic = (error) => ({
  name: error instanceof PageAlertError ? 'PageAlertError' : error instanceof CheckError ? 'CheckError'
    : error?.name === 'TimeoutError' ? 'TimeoutError' : 'Error',
  message: error instanceof CheckError ? redact(error.message)
    : error?.name === 'TimeoutError' ? 'Browser operation timed out.'
    : 'Browser, filesystem, or process operation failed; raw diagnostic withheld.',
});
const check = (ok, message) => { if (!ok) throw new CheckError(message); };

function loadClip(path) {
  let b;
  try { b = readFileSync(path); } catch (error) {
    if (error?.code === 'ENOENT') throw new CheckError('Expected WAV is missing from clips/.');
    throw error;
  }
  check(b.length >= 44 && b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WAVE', 'Not a RIFF/WAVE clip.');
  let pcm = false, bytes = 0;
  for (let i = 12; i + 8 <= b.length;) {
    const tag = b.toString('ascii', i, i + 4), n = b.readUInt32LE(i + 4), p = i + 8;
    check(p + n <= b.length, 'Truncated WAV chunk.');
    if (tag === 'fmt ' && n >= 16) {
      pcm = b.readUInt16LE(p) === 1 && b.readUInt16LE(p + 2) === 1 &&
        b.readUInt32LE(p + 4) === 48000 && b.readUInt16LE(p + 12) === 2 &&
        b.readUInt16LE(p + 14) === 16;
    }
    if (tag === 'data') bytes += n;
    i = p + n + (n % 2);
  }
  const ms = Math.ceil(bytes / 96);
  check(pcm && bytes % 2 === 0 && ms >= 500 && ms <= 20000, 'Need 0.5–20 s of 48 kHz mono PCM16.');
  return { ms, sha256: createHash('sha256').update(b).digest('hex') };
}

async function until(fn, ms, message) {
  const deadline = Date.now() + ms;
  do {
    if (await fn()) return;
    await sleep(50);
  } while (Date.now() < deadline);
  throw new CheckError(message);
}

const forbidden = new Set(['chat.send', 'sessions.send', 'sessions.dispatch', 'agent']);
function blockedMethod(f) {
  if (f?.type !== 'req') return null;
  if (forbidden.has(f.method)) return f.method;
  // Empty session allocation is part of /new dictation; starting a turn is not.
  if (f.method === 'sessions.create' &&
      (f.params?.message || f.params?.task || f.params?.attachments?.length)) return f.method;
  if (f.method === 'talk.session.create' && f.params?.mode !== 'transcription') return f.method;
  return null;
}

async function guard(page, origin, o) {
  const tracks = new Map();
  o.track = (id) => {
    if (!tracks.has(id)) tracks.set(id, { ready: false, bytes: 0, finals: [], partial: '', events: [] });
    return tracks.get(id);
  };
  await page.routeWebSocket((url) => url.host === new URL(origin).host, (client) => {
    const server = client.connectToServer();
    let createId;
    const parse = (message) => { try { return JSON.parse(message.toString()); } catch { return null; } };
    client.onMessage((message) => {
      const f = parse(message), blocked = blockedMethod(f);
      if (blocked) {
        o.blocked.push(blocked);
        client.send(JSON.stringify({
          type: 'res', id: f.id, ok: false,
          error: { code: 'INVALID_REQUEST', message: 'Unsent-draft harness blocked this request.' },
        }));
        return;
      }
      if (f?.type === 'req' && f.method === 'talk.session.create') createId = f.id;
      server.send(message);
    });
    server.onMessage((message) => {
      const f = parse(message), p = f?.payload;
      if (f?.type === 'res' && createId && f.id === createId) {
        o.admission = f.ok ? { id: p?.transcriptionSessionId, provider: p?.provider } : {};
      }
      if (f?.type === 'event' && f.event === 'talk.event' && p?.transcriptionSessionId) {
        const t = o.track(p.transcriptionSessionId);
        t.events.push({
          type: typeof p.type === 'string' ? redact(p.type) : null,
          final: typeof p.final === 'boolean' ? p.final : null,
          seq: Number.isSafeInteger(f.seq) ? f.seq : null,
          textLength: typeof p.text === 'string' ? p.text.length : null,
          phase: o.stopRequested ? 'afterStop' : 'beforeStop',
        });
        if (p.type === 'ready') t.ready = true;
        if (p.type === 'inputAudio' && Number.isSafeInteger(p.byteLength)) t.bytes += p.byteLength;
        if (p.type === 'partial' && typeof p.text === 'string') t.partial = p.text.trim();
        if (p.type === 'transcript' && p.final === true && typeof p.text === 'string' && p.text.trim()) {
          t.finals.push(p.text.trim());
          t.partial = '';
        }
        if (p.type === 'error') t.error = true;
        if (p.type === 'close') t.closed = p.reason === 'completed' ? 'completed' : 'abnormal';
      }
      client.send(message);
    });
  });
}

const alertSelector = '[role="alert"], .callout.danger, .new-session-page__error';

async function runCase(chromium, origin, env, run, source, c, take) {
  const id = c.id + (take ? '--' + take.id : '');
  const out = join(run, id), path = join(here, 'clips', id + '.wav');
  mkdirSync(out);
  const o = { blocked: [], stopRequested: false };
  const visibleAlerts = [];
  let browser, page, draft, t, clip, failure = null, screenshotFailure = null, screenshot = false;
  let step = 'read-clip', status = 'FAIL', value = '', editable = false;

  const alerts = async () => {
    if (!page || page.isClosed()) return [];
    const texts = await page.locator(alertSelector).filter({ visible: true })
      .evaluateAll((nodes) => nodes.map((node) => node.innerText.trim()).filter(Boolean));
    for (const text of new Set(texts.map(redact))) {
      if (!visibleAlerts.some((a) => a.step === step && a.text === text)) visibleAlerts.push({ step, text });
    }
    return texts;
  };
  const uiUntil = (fn, ms, message) => until(async () => {
    const texts = await alerts();
    if (await fn()) return true;
    if (texts.length) throw new PageAlertError(texts.join('\n'));
    return false;
  }, ms, message);

  try {
    clip = loadClip(path);
    step = 'launch-browser';
    browser = await chromium.launch({ channel: 'chromium', env, args: [
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--use-file-for-fake-audio-capture=' + path + '%noloop',
    ] });
    const context = await browser.newContext({
      permissions: ['microphone'], locale: 'en-US', serviceWorkers: 'block',
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    step = 'open-new-session';
    await guard(page, origin, o);
    await page.goto(origin + '/new', { waitUntil: 'domcontentloaded' });
    const shell = page.locator('.agent-chat__composer-shell');
    draft = shell.locator(
      'textarea[aria-label="Chat composer"], textarea[aria-label="Ask me anything, or hand me something to do"]',
    );
    const setup = page.getByText('Set up a model', { exact: true });
    const dictate = shell.getByRole('button', { name: 'Dictate', exact: true });
    const stop = shell.getByRole('button', { name: 'Stop and keep text', exact: true });
    const usable = async (control) => await control.isVisible() && await control.isEnabled({ timeout: 500 });

    step = 'wait-for-composer-and-model';
    await uiUntil(async () => await draft.isVisible() && await draft.isEditable({ timeout: 500 }) &&
      await setup.filter({ visible: true }).count() === 0 && await usable(dictate),
    30000, 'Model setup did not clear or composer/mic stayed disabled.');
    check(await draft.inputValue() === '', 'Starting draft was not empty.');

    step = 'admit-openai-transcription';
    await dictate.click();
    await uiUntil(() => o.admission, 15000, 'No transcription admission response.');
    check(o.admission.id && o.admission.provider === 'openai',
      'Gateway did not admit the OpenAI transcription relay.');
    t = o.track(o.admission.id);

    step = 'capture-clip';
    // The relay accepts 8 kHz G.711 u-law (one byte per sample).
    await uiUntil(() => t.error || t.closed || (t.ready && t.bytes >= clip.ms * 8), clip.ms + 20000,
      'Provider did not become ready and accept a full clip duration of audio.');
    check(!t.error && !t.closed, 'Relay failed before the clip completed.');

    step = 'wait-for-stop-control';
    await uiUntil(() => usable(stop), 15000, 'Stop and keep text did not become available.');
    step = 'stop-and-drain';
    o.stopRequested = true; // Mark the boundary immediately before attempting the Stop click.
    await stop.click();
    await uiUntil(() => t.error || t.closed, 30000, 'No relay terminal event.');
    check(!t.error && t.closed === 'completed', 'Relay did not close cleanly.');

    step = 'verify-final-draft';
    const phase = shell.locator('.agent-chat__dictation-status');
    const rendered = [...t.finals, t.partial].filter(Boolean).join(' ');
    await uiUntil(async () => await draft.isVisible() && !(await phase.isVisible()) &&
      await draft.isEditable({ timeout: 500 }) && await draft.inputValue({ timeout: 500 }) === rendered,
    10000, 'Composer did not settle to the relay text in an editable draft.');
    status = words(t.finals.join(' ')) === words(c.expected.words) ? 'PASS' : 'INCONCLUSIVE_STT';
  } catch (error) {
    const texts = error instanceof PageAlertError ? [] : await alerts().catch(() => []);
    const cause = texts.length ? new PageAlertError(texts.join('\n')) : error;
    if (cause instanceof PageAlertError) status = 'ERROR';
    failure = { step, ...diagnostic(cause) };
  } finally {
    try {
      if (page && !page.isClosed()) {
        step = 'capture-page';
        await alerts();
        if (await draft?.isVisible()) {
          value = await draft.inputValue({ timeout: 2000 });
          editable = await draft.isEditable({ timeout: 2000 });
        }
        // Capture the actual page, even when the composer never rendered. No masking.
        // Suppress the PNG rather than publishing a frame containing a detected secret.
        const text = await page.locator('body').evaluate((body) => [body.innerText,
          ...Array.from(body.querySelectorAll('input, textarea'), (el) => el.value),
        ].join('\n'), undefined, { timeout: 2000 });
        check(redact(text) === text, 'Sensitive pattern detected; screenshot withheld.');
        await page.screenshot({
          path: join(out, 'draft.png'), fullPage: true, animations: 'disabled', timeout: 3000,
        });
        screenshot = true;
      }
    } catch (error) {
      screenshotFailure = diagnostic(error);
      failure ??= { step: 'capture-page', ...screenshotFailure };
    }
    await browser?.close().catch(() => {
      failure ??= { step: 'close-browser', ...diagnostic(new CheckError('Browser did not close.')) };
    });
    if (o.blocked.length) {
      status = 'FAIL';
      failure = {
        step: 'no-send-guard', name: 'ForbiddenRequest',
        message: 'Blocked ' + [...new Set(o.blocked)].join(', ') + ' before forwarding.',
      };
    }
    if (failure && status !== 'ERROR') status = 'FAIL';
    t ??= o.admission?.id ? o.track(o.admission.id) : undefined;
    writeFileSync(join(out, 'transcript.txt'), redact(t?.finals.join(' ') ?? '') + '\n');
    writeFileSync(join(out, 'state.json'), JSON.stringify({
      ...source, caseId: c.id, takeId: take?.id ?? null, status, failure, chatModel, configuredSttModel: sttModel,
      provider: o.admission?.provider === 'openai' ? 'openai' : null, expectedWords: c.expected.words,
      clip: clip ?? null, relayReady: t?.ready ?? false, audioBytes: t?.bytes ?? 0,
      finalEvents: t?.finals.length ?? 0, relayClose: t?.closed ?? null,
      gatewayEvents: t?.events ?? [], visibleAlerts, stopRequested: o.stopRequested,
      blockedRequests: o.blocked, editable, screenshot, screenshotFailure, draft: redact(value),
    }, null, 2) + '\n');
  }
  console.log(id + ': ' + status + (failure ? ' (' + failure.step + ')' : ''));
  return status;
}

async function main() {
  check(key && process.argv[2] && process.platform === 'linux',
    'Need OPENAI_API_KEY and a built checkout on Linux.');
  check(statfsSync('/dev/shm').type === 0x01021994 &&
    readFileSync('/proc/swaps', 'utf8').trim().split('\n').length === 1,
    'Need tmpfs at /dev/shm and swap disabled.');

  const root = realpathSync(process.argv[2]);
  const { cases, takes } = JSON.parse(readFileSync(join(here, 'scenario.json'), 'utf8'));
  const ids = (items) => Array.isArray(items) && items.length > 0 &&
    items.every((x) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x?.id ?? '')) &&
    new Set(items.map((x) => x.id)).size === items.length;
  check(ids(cases) && cases.every((c) => typeof c.expected?.words === 'string' &&
    words(c.expected.words) && redact(c.expected.words) === c.expected.words && c.expected.sends === 0) &&
    (takes === undefined || (Array.isArray(takes) && (!takes.length || ids(takes)))),
    'Invalid cases or takes.');

  const git = (rev) => execFileSync('git', ['-C', root, 'rev-parse', rev], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const source = { commit: git('HEAD'), tree: git('HEAD^{tree}') };
  try { execFileSync('git', ['-C', root, 'diff', '--quiet', 'HEAD', '--'], { stdio: 'ignore' }); }
  catch { throw new CheckError('Built checkout has tracked changes or Git could not verify it.'); }
  const build = JSON.parse(readFileSync(join(root, 'dist', 'build-info.json'), 'utf8'));
  check(build.commit === source.commit, 'Build commit does not match checkout HEAD.');

  process.env.PLAYWRIGHT_BROWSERS_PATH ??=
    join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ms-playwright');
  const { chromium } = createRequire(join(root, 'ui', 'package.json'))('playwright');
  const work = mkdtempSync('/dev/shm/ct-dictation-');
  let child, exited, dead = false;
  try {
    for (const n of ['home', 'tmp', 'state', 'workspace']) mkdirSync(join(work, n));
    const tmp = join(work, 'tmp'), home = join(work, 'home');
    const env = {
      PATH: process.env.PATH || '/usr/bin:/bin', HOME: home,
      TMPDIR: tmp, TEMP: tmp, TMP: tmp, LANG: 'C.UTF-8',
    };
    Object.assign(process.env, { TMPDIR: tmp, TEMP: tmp, TMP: tmp });
    const port = await new Promise((resolve, reject) => {
      const s = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close((err) => err ? reject(err) : resolve(port));
      });
    });
    const origin = 'http://127.0.0.1:' + port, config = join(work, 'openclaw.json');
    writeFileSync(config, JSON.stringify({
      gateway: { mode: 'local', bind: 'loopback', auth: { mode: 'none' }, controlUi: { enabled: true } },
      agents: { defaults: {
        workspace: join(work, 'workspace'), model: { primary: chatModel },
        models: { [chatModel]: {} }, voiceModel: 'openai/' + sttModel,
      } },
      plugins: { allow: ['openai'], entries: { openai: { enabled: true } } },
      cron: { enabled: false }, models: { catalogRefresh: { enabled: false } },
      logging: { file: join(work, 'gateway.log') },
    }), { mode: 0o600 });
    child = spawn(process.execPath, [
      join(root, 'openclaw.mjs'), 'gateway', 'run', '--bind', 'loopback', '--port', String(port),
    ], {
      cwd: work, detached: true, stdio: 'ignore',
      env: {
        ...env, OPENAI_API_KEY: key, OPENCLAW_HOME: home,
        OPENCLAW_STATE_DIR: join(work, 'state'), OPENCLAW_CONFIG_PATH: config,
        OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_DISABLE_BONJOUR: '1', NODE_DISABLE_COMPILE_CACHE: '1',
      },
    });
    exited = once(child, 'exit').catch(() => []).finally(() => { dead = true; });
    await until(async () => {
      check(!dead, 'Gateway exited before readiness.');
      const r = await fetch(origin + '/readyz', { signal: AbortSignal.timeout(800) }).catch(() => null);
      if (!r) return false;
      await r.body?.cancel();
      return r.ok;
    }, 90000, 'Gateway did not become ready.');

    const parent = join(here, 'results');
    mkdirSync(parent, { recursive: true });
    const run = mkdtempSync(join(parent, 'run-'));
    const statuses = [];
    for (const c of cases) for (const take of takes?.length ? takes : [null]) {
      statuses.push(await runCase(chromium, origin, env, run, source, c, take));
    }
    return statuses.some((s) => s === 'FAIL' || s === 'ERROR') ? 1
      : statuses.includes('INCONCLUSIVE_STT') ? 2 : 0;
  } finally {
    if (child?.pid) {
      const signal = (name) => {
        try { process.kill(-child.pid, name); } catch (e) { if (e.code !== 'ESRCH') throw e; }
      };
      signal('SIGTERM');
      await Promise.race([exited, sleep(5000, undefined, { ref: false })]);
      signal('SIGKILL');
      await exited;
    }
    rmSync(work, { recursive: true, force: true });
  }
}

main().then((code) => { process.exitCode = code; }, (error) => {
  console.error('Setup failed: ' + diagnostic(error).message);
  process.exitCode = 1;
});
