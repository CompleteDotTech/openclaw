import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const HEAD = '8b9b1489296846a05300227a2670a14df8cd67a8';
const STT = 'gpt-4o-mini-transcribe';
const CHAT = 'openai/gpt-5.4-mini';
const here = dirname(fileURLToPath(import.meta.url));
const key = process.env.OPENAI_API_KEY?.trim();
delete process.env.OPENAI_API_KEY;

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const slug = (s) => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
const segmenter = new Intl.Segmenter('en', { granularity: 'word' });
const words = (s) => [...segmenter.segment(s.toLowerCase())]
  .filter((x) => x.isWordLike).map((x) => x.segment).join(' ');

const redacted = (s) => (key ? String(s).split(key).join('[redacted]') : String(s))
  .replace(/\bsk-[\w-]+|\bBearer\s+[^\s"']+/gi, '[redacted]')
  .replace(/https?:\/\/[^\s"'<>]+|wss?:\/\/[^\s"'<>]+/gi, '[url]')
  .replace(/((?:api[_-]?key|(?:device|bootstrap|access)?token|password|authorization)["']?\s*[:=]\s*)["']?[^\s"',;&}]+/gi, '$1[redacted]');

class ProofFailure extends Error { name = 'ProofFailure'; }
class InconclusiveStt extends Error { name = 'InconclusiveStt'; }
const check = (ok, msg) => { if (!ok) throw new ProofFailure(msg); };

async function until(test, msg, ms = 20_000, ErrorType = Error) {
  const end = Date.now() + ms;
  do {
    if (await test()) return;
    await sleep(40);
  } while (Date.now() < end);
  throw new ErrorType(msg);
}

async function wavTarget(path) {
  const b = await readFile(path);
  const tag = (i) => b.toString('ascii', i, i + 4);
  if (b.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('Expected RIFF/WAVE');
  }
  let pcm = false, size = 0;
  for (let i = 12; i + 8 <= b.length;) {
    const len = b.readUInt32LE(i + 4), p = i + 8;
    if (p + len > b.length) throw new Error('Truncated WAV chunk');
    if (tag(i) === 'fmt ' && len >= 16) {
      pcm = b.readUInt16LE(p) === 1 && b.readUInt16LE(p + 2) === 1 &&
        b.readUInt32LE(p + 4) === 48_000 && b.readUInt16LE(p + 14) === 16;
    }
    if (tag(i) === 'data') size = len;
    i = p + len + (len & 1);
  }
  if (!pcm || size % 2 || size < 96_000 || size > 30 * 96_000) {
    throw new Error('Expected 1–30 s, 48 kHz mono PCM16 WAV');
  }
  // 8 kHz μ-law at the Gateway; stop within trailing silence, before EOF.
  return Math.floor(size / 12) - 800;
}

async function guardSocket(page, base) {
  const w = { requests: [], replies: new Map(), events: [], blocked: [], sent: [], permit: null };
  const sends = new Set(['chat.send', 'sessions.send', 'agent', 'sessions.dispatch', 'sessions.companion.ask']);
  const parse = (m) => { try { return JSON.parse(m.toString()); } catch { return null; } };

  await page.routeWebSocket((url) => url.host === new URL(base).host, (client) => {
    const server = client.connectToServer(), tracked = new Set();
    client.onMessage((message) => {
      const f = parse(message);
      if (f?.type === 'req' && sends.has(f.method)) {
        if (f.method !== 'chat.send' || w.permit === null ||
            f.params?.message !== w.permit || w.sent.length) {
          w.blocked.push(f.method);
          client.send(JSON.stringify({
            type: 'res', id: f.id, ok: false,
            error: { code: 'INVALID_REQUEST', message: 'Blocked by dictation proof' },
          }));
          return;
        }
        w.permit = null; // Consume the permit before forwarding.
        w.sent.push(f.id);
        tracked.add(f.id);
      } else if (f?.type === 'req' && ['talk.session.create', 'talk.session.close'].includes(f.method)) {
        w.requests.push({ id: f.id, method: f.method, mode: f.params?.mode, discard: f.params?.discard });
        tracked.add(f.id);
      }
      server.send(message);
    });

    server.onMessage((message) => {
      const f = parse(message), p = f?.payload;
      if (f?.type === 'res' && tracked.has(f.id)) {
        w.replies.set(f.id, { ok: f.ok, id: p?.transcriptionSessionId, provider: p?.provider, status: p?.status });
      } else if (f?.type === 'event' && f.event === 'talk.event' && p?.transcriptionSessionId) {
        w.events.push({
          id: p.transcriptionSessionId, type: p.type, reason: p.reason,
          final: p.final, text: p.type === 'transcript' ? p.text : undefined, bytes: p.byteLength,
        });
      }
      client.send(message);
    });
  });
  return w;
}

async function openSidebar(pane) {
  if (await pane.locator('.chat-session-rail__input:visible').count()) return;
  const panels = button(pane.locator('.sidebar-region__panels-toggle'), 'Panels');
  if ((await panels.getAttribute('aria-expanded')) !== 'true') await panels.click();
  const launcher = pane.locator('.side-panel-launcher:visible');
  const newTab = button(pane.locator('[data-region-header="side"]'), 'New tab');
  await launcher.or(newTab).first().waitFor();
  if (!(await launcher.isVisible())) await newTab.click();
  await launcher.getByRole('button').filter({
    has: launcher.page().locator('.side-panel-type-option__label')
      .and(launcher.page().getByText('Side chat', { exact: true })),
  }).click();
}

async function runTake(chromium, base, env, out, c, take, sendOnce) {
  const e = c.expected, name = c.id + (take ? '--' + take.id : '');
  const path = join(here, 'clips', name + '.wav'), dir = join(out, name);
  await mkdir(dir);
  const s = {
    head: HEAD, case: c.id, take: take?.id ?? null, surface: e.surface, mode: e.mode,
    probe: e.action, proof: 'Chromium fake-media capture with a prerecorded WAV',
    sttModel: STT, status: 'ERROR', step: 'read-clip', expectedWords: e.words,
  };
  let browser, page, wire, input, transcript = '';
  const shot = (file) => page.screenshot({
    path: join(dir, file), animations: 'disabled', timeout: 5000,
    mask: [page.locator('[role="alert"], .agent-chat__dictation-status, .agent-chat__error')],
  });
  const record = (err, status) => {
    s.status = status;
    s.error = {
      step: s.step, name: redacted(err?.name ?? 'Error').slice(0, 80),
      message: redacted(err?.message ?? err).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 1800),
    };
  };

  try {
    const targetBytes = await wavTarget(path);
    s.step = 'launch-chromium';
    browser = await chromium.launch({ env, args: [
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--use-file-for-fake-audio-capture=' + path + '%noloop',
    ] });
    const context = await browser.newContext({
      locale: 'en-US', viewport: { width: 1440, height: 900 },
      serviceWorkers: 'block', acceptDownloads: false,
    });
    await context.grantPermissions(['microphone', 'clipboard-read', 'clipboard-write'], { origin: base });
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    wire = await guardSocket(page, base);

    s.step = 'open-composer';
    await page.goto(base + (e.surface === 'new' ? '/new' : '/chat/main'));
    const connected = () => page.waitForFunction(
      () => window.openclawControlUi?.snapshot().gatewayPhase === 'connected',
    );
    await connected();
    const pane = page.locator(
      '.chat-pane-cache__pane--active:visible, .chat-split-view__cell--active openclaw-chat-pane:visible',
    ).first();
    if (e.surface === 'sidebar') await openSidebar(pane);
    const root = e.surface === 'new' ? page.locator('.new-session-page__composer:visible') :
      e.surface === 'sidebar' ? pane.locator('.chat-session-rail__composer:visible') :
      pane.locator('.agent-chat__composer-shell:visible');
    input = root.locator({
      chat: 'textarea[aria-label="Chat composer"]',
      new: '.new-session-page__message',
      sidebar: '.chat-session-rail__input',
    }[e.surface]);
    const ready = () => until(async () => await input.isVisible() &&
      await input.isEnabled() && await input.isEditable() &&
      !(await page.getByText('Set up a model', { exact: true }).filter({ visible: true }).count()),
    'Composer not ready (disabled, read-only, or model setup visible)');
    s.step = 'wait-for-ready-composer';
    await ready();

    const originalDraft = e.initialDraft ?? '';
    const dialog = page.getByRole('dialog', { name: 'Dictation cleanup', exact: true });
    const mode = dialog.getByLabel('Cleanup mode', { exact: true });
    const review = button(root, 'Review dictation');
    const closeDialog = async () => {
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
    };
    s.step = 'set-and-check-policy';
    await button(root, 'Dictation cleanup').click();
    check(await mode.inputValue() === 'off', 'Fresh browser did not default to Off');
    if (e.mode === 'conservative') await mode.selectOption('conservative');
    await closeDialog();
    if (e.action === 'edit-and-copy') {
      await page.reload();
      await connected();
      await ready();
      await button(root, 'Dictation cleanup').click();
      check(await mode.inputValue() === 'conservative', 'Preference did not survive same-build reload');
      await closeDialog();
    }
    await input.fill(originalDraft);

    s.step = 'capture-wav';
    const mic = button(root, e.surface === 'new' ? 'Dictate' : 'Start voice input');
    const create = () => wire.requests.find((r) => r.method === 'talk.session.create' && r.mode === 'transcription');
    if (e.surface === 'chat') {
      await mic.hover();
      await page.mouse.down();
      try { await until(create, 'Chat hold did not start dictation'); } finally { await page.mouse.up(); }
    } else {
      await mic.click();
    }
    await until(() => create() && wire.replies.has(create().id), 'No dictation admission response');
    const admission = wire.replies.get(create().id);
    if (!admission.ok || admission.provider !== 'openai' || !admission.id) {
      throw new Error('Expected OpenAI dictation admission');
    }
    s.provider = 'openai';
    const events = () => wire.events.filter((x) => x.id === admission.id);
    const close = () => events().find((x) => x.type === 'close');
    const audio = () => events().reduce((n, x) => n + (x.type === 'inputAudio' ? x.bytes : 0), 0);
    await until(() => close() || audio() >= targetBytes, 'Gateway did not receive enough capture audio', 45_000);
    if (close()) throw new Error('Capture closed before Stop');
    s.gatewayAudioBytes = audio();

    s.step = 'finalize-stt';
    await button(root, 'Stop and keep text').click();
    await until(close, 'No transcription close event', 90_000);
    const stop = wire.requests.find((r) => r.method === 'talk.session.close');
    const snapshot = events();
    const finals = snapshot.filter((x) => x.type === 'transcript' && x.final === true && x.text?.trim());
    transcript = finals.map((x) => x.text.trim()).join(' ');
    s.finalEvents = finals.length;
    s.closeReason = close().reason;
    if (!stop || stop.discard || s.closeReason !== 'completed' || snapshot.some((x) => x.type === 'error')) {
      throw new Error('Transcription did not close normally');
    }
    if (![e.words, ...(e.variants ?? [])].some((w) => words(w) === words(transcript))) {
      throw new InconclusiveStt('Final Gateway transcript did not match the authored words');
    }

    s.step = 'assert-preservation';
    if (e.mode === 'off') {
      await until(async () => await input.inputValue() === transcript, 'Off changed Gateway text', 10_000, ProofFailure);
      check(await review.count() === 0, 'Off unexpectedly offered review');
    } else {
      await review.click();
      const original = dialog.getByLabel('Original recognized text', { exact: true });
      const use = button(dialog, 'Use original');
      check(await original.inputValue() === transcript, 'Review text differed from Gateway final');
      check(await input.inputValue() === originalDraft, 'Review changed the unsent draft');
      check(await dialog.getByRole('status').textContent() ===
        'Cleanup is unavailable. The original recognized text is unchanged.',
      'Missing semantic-unavailable status');
      for (const label of ['Use cleaned draft', 'Restore original']) {
        check(await button(dialog, label).count() === 0, 'Unexpected action: ' + label);
      }

      s.step = 'assert-escape-recovery';
      await original.focus();
      await closeDialog();
      await until(() => review.evaluate((el) => el.matches(':focus')),
        'Escape did not return focus', 2000, ProofFailure);
      check(await input.inputValue() === originalDraft, 'Escape changed the unsent draft');
      if (e.action === 'edit-and-copy') await input.fill(e.editedDraft);
      await review.press('Enter');
      check(await original.inputValue() === transcript, 'Reopened review lost the original');
      await shot('review.png');

      if (e.action === 'edit-and-copy') {
        s.step = 'assert-edit-and-copy';
        check(await use.isDisabled(), 'Editing did not revoke Use original');
        await button(dialog, 'Copy original text').click();
        await until(async () => await page.evaluate(() => navigator.clipboard.readText()) === transcript,
          'Clipboard differed from the exact original', 5000, ProofFailure);
        await button(dialog, 'Dismiss review').click();
        await dialog.waitFor({ state: 'hidden' });
        check(await input.inputValue() === e.editedDraft && await review.count() === 0,
          'Dismiss changed the edit or kept the review');
      } else {
        s.step = 'assert-use-original';
        const focused = () => use.evaluate((el) => el.matches(':focus'));
        await mode.focus();
        for (let i = 0; i < 14 && !(await focused()); i++) await page.keyboard.press('Tab');
        check(await focused() && await use.isEnabled(), 'Final Use original was not keyboard reachable');
        await page.keyboard.press('Enter');
        await dialog.waitFor({ state: 'hidden' });
        check(await input.inputValue() === transcript && await review.count() === 0,
          'Use original did not insert one exact final draft');
      }
    }

    check(!wire.blocked.length && !wire.sent.length, 'Unexpected submit attempt before explicit Send');
    if (e.action === 'use-and-send' && !sendOnce.claimed) {
      s.step = 'assert-explicit-send';
      sendOnce.claimed = true;
      wire.permit = transcript;
      await button(root, 'Send message').click();
      await until(() => wire.blocked.length || (wire.sent.length === 1 && wire.replies.has(wire.sent[0])),
        'No explicit Send acknowledgement');
      wire.permit = null;
      const ack = wire.replies.get(wire.sent[0]);
      check(ack?.ok && ['started', 'ok'].includes(ack.status), 'Gateway did not accept one exact chat.send');
      await until(async () => await input.inputValue() === '', 'Sent draft did not clear', 10_000, ProofFailure);
      s.sendAck = ack.status;
    }
    s.status = 'PASS';
    s.step = 'complete';
  } catch (err) {
    record(err, err instanceof InconclusiveStt ? 'INCONCLUSIVE_STT' :
      err instanceof ProofFailure ? 'FAIL' : 'ERROR');
  } finally {
    if (wire) wire.permit = null;
    const auxiliary = (err, step) => {
      if (s.status === 'PASS') {
        s.step = step;
        record(err, 'ERROR');
      }
    };
    if (page) {
      s.draft = input ? await input.inputValue({ timeout: 1000 }).then(redacted, () => null) : null;
      await shot('final.png').then(
        () => { s.screenshot = 'final.png'; },
        (err) => auxiliary(err, 'final-screenshot'),
      );
    }
    await browser?.close().catch((err) => auxiliary(err, 'close-browser'));
    s.sent = wire?.sent.length ?? 0;
    s.blocked = wire?.blocked ?? [];
    if (s.blocked.length) {
      s.step = 'send-guard';
      record(new ProofFailure('Blocked unexpected RPC: ' + s.blocked.join(', ')), 'FAIL');
    }
    await writeFile(join(dir, 'transcript.txt'), redacted(transcript));
    await writeFile(join(dir, 'state.json'), JSON.stringify(s, null, 2) + '\n');
    console.log(name, s.status, s.step);
  }
  return s;
}

function caseStatus(runs, action) {
  if (runs.some((r) => r.status === 'FAIL')) return 'FAIL';
  if (runs.some((r) => r.status === 'ERROR')) return 'ERROR';
  if (runs.every((r) => r.status === 'INCONCLUSIVE_STT')) return 'INCONCLUSIVE_STT';
  return action !== 'use-and-send' || runs.some((r) => r.status === 'PASS' && r.sendAck) ? 'PASS' : 'FAIL';
}

async function main() {
  if (process.argv.length !== 3 || !key) {
    throw new Error('Usage: set OPENAI_API_KEY and run node dictation-proof.mjs <built checkout>');
  }
  const checkout = resolve(process.argv[2]);
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (git('rev-parse', 'HEAD') !== HEAD || git('status', '--porcelain', '--untracked-files=no') ||
      (await json(join(checkout, 'dist', 'build-info.json'))).commit !== HEAD) {
    throw new Error('Expected a clean build of the pinned PR SHA');
  }
  const ui = join(checkout, 'dist', 'control-ui');
  await access(join(ui, 'index.html'));
  const { chromium } = createRequire(join(checkout, 'ui', 'package.json'))('playwright');
  const fixture = await json(join(here, 'scenario.json'));
  const validIds = (rows) => rows.length && rows.every((x) => slug(x.id)) &&
    new Set(rows.map((x) => x.id)).size === rows.length;
  if (fixture.leadingSilenceMs !== 500 || !validIds(fixture.cases) ||
      (fixture.takes && !validIds(fixture.takes))) {
    throw new Error('Invalid scenario or take IDs');
  }

  const results = join(here, 'results');
  await mkdir(results, { recursive: true });
  const out = await mkdtemp(join(results, 'run-'));
  const state = await mkdtemp(join(tmpdir(), 'dictation-gw-'));
  let gateway, exited;
  try {
    const listener = createServer().listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise((ok, fail) => listener.close((err) => err ? fail(err) : ok()));
    const base = 'http://127.0.0.1:' + port;
    const config = join(state, 'openclaw.json'), workspace = join(state, 'workspace');
    const env = { PATH: process.env.PATH, HOME: state, TMPDIR: join(state, 'tmp'), LANG: 'C.UTF-8' };
    await mkdir(workspace);
    await mkdir(env.TMPDIR);
    await writeFile(config, JSON.stringify({
      gateway: {
        mode: 'local', bind: 'loopback', port, auth: { mode: 'none' },
        controlUi: { enabled: true, root: ui }, tailscale: { mode: 'off' },
      },
      cron: { enabled: false },
      logging: { level: 'silent', consoleLevel: 'silent' },
      plugins: { allow: ['openai'], entries: { openai: { enabled: true } } },
      agents: { defaults: { workspace, model: { primary: CHAT }, models: { [CHAT]: {} } } },
      tools: {
        profile: 'minimal',
        media: {
          audio: { enabled: true },
          models: [{ provider: 'openai', model: STT, capabilities: ['audio'] }],
        },
      },
    }), { mode: 0o600 });

    gateway = spawn(process.execPath, [
      join(checkout, 'openclaw.mjs'), 'gateway', 'run', '--bind', 'loopback', '--port', String(port),
    ], {
      cwd: state, detached: true, stdio: 'ignore',
      env: {
        ...env, OPENAI_API_KEY: key, OPENCLAW_HOME: state, OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: config, OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_DISABLE_BONJOUR: '1',
      },
    });
    let stopped = false;
    exited = new Promise((done) => {
      for (const event of ['exit', 'error']) gateway.once(event, () => { stopped = true; done(); });
    });
    await until(async () => {
      if (stopped) throw new Error('Gateway exited before readiness');
      return fetch(base + '/readyz', { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
    }, 'Gateway readiness timed out', 120_000);

    const summary = [];
    for (const c of fixture.cases) {
      const runs = [], sendOnce = { claimed: false };
      for (const take of fixture.takes ?? [null]) {
        runs.push(await runTake(chromium, base, env, out, c, take, sendOnce));
      }
      summary.push({
        id: c.id, status: caseStatus(runs, c.expected.action),
        takes: runs.map(({ take, status, sendAck }) => ({ take, status, sendAck })),
      });
    }
    await writeFile(join(out, 'summary.json'), JSON.stringify({ head: HEAD, cases: summary }, null, 2) + '\n');
    process.exitCode = summary.some((x) => x.status === 'FAIL' || x.status === 'ERROR') ? 1 :
      summary.some((x) => x.status === 'INCONCLUSIVE_STT') ? 2 : 0;
  } finally {
    if (gateway?.pid) {
      const signal = (name) => {
        try { process.kill(-gateway.pid, name); } catch (err) { if (err.code !== 'ESRCH') throw err; }
      };
      signal('SIGTERM');
      if (!await Promise.race([exited.then(() => true), sleep(3000, false)])) {
        signal('SIGKILL');
        await exited;
      }
    }
    await rm(state, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(redacted(err?.message ?? err));
  process.exitCode = 1;
});
