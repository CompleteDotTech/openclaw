// Node 24, Linux. Run only in an isolated job on author-reviewed code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { randomBytes, createHash } = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { once } = require('node:events');
class ProofTimeout extends Error { name = 'ProofTimeout'; }
class MissingControl extends Error { name = 'MissingControl'; }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (test, label, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await test()) return;
    await sleep(100);
  }
  throw new ProofTimeout(label);
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const key = process.env.OPENAI_API_KEY;
delete process.env.OPENAI_API_KEY;
const token = randomBytes(32).toString('hex');
const scrubSecrets = s => String(s ?? '').split(key || '\0').join('[redacted]')
  .split(token).join('[redacted]').replace(/\b(?:sk|ek)-[\w-]{8,}/g, '[redacted]')
  .replace(/\bBearer\s+\S+/gi, '[redacted]')
  .replace(/([?#&](?:[\w-]*token|[\w-]*key|password|secret|code|signature)=)[^&\s#]+/gi, '$1[redacted]')
  .replace(/(\b\w+:\/\/)[^/\s@]+@/g, '$1[redacted]@');
const scrub = s => scrubSecrets(s).replace(/https?:\/\/\S+/gi, '[url]');
const words = s => (s.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
const draft = 'Proof note:';
class PrematureSubmit extends Error { name = 'PrematureSubmit'; }
const submits = new Set(['chat.send', 'sessions.send', 'agent', 'sessions.companion.ask', 'sessions.create', 'sessions.dispatch']);
const runId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const sttModel = 'gpt-4o-mini-transcribe';
const errorInfo = e => ({ name: scrub(e?.name || 'Error').slice(0, 80),
  message: scrub(e?.message ?? e).slice(0, 1200) });
const button = (scope, name) => scope.getByRole('button', { name, exact: true }).filter({ visible: true }).first();

function createProofSession(checkout, env, target, label, result) {
  const child = spawnSync(process.execPath, ['openclaw.mjs', 'gateway', 'call', 'sessions.create', '--json',
    '--params', JSON.stringify({ agentId: 'main', key: target, label })], {
    cwd: checkout, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 40000,
    maxBuffer: 256 * 1024,
  });
  const clean = value => scrub(String(value ?? '')
    .split(env.OPENCLAW_GATEWAY_TOKEN || '\0').join('[redacted]')
    .split(env.HOME).join('[proof-runtime]').split(checkout).join('[checkout]')).trim().slice(0, 4000);
  let reply;
  try { reply = JSON.parse(child.stdout); } catch { /* stderr and process status still survive */ }
  const gatewayError = reply?.error ?? reply?.runError;
  result.sessionCreateCli = {
    label, exitCode: child.status, signal: child.signal, spawnError: clean(child.error?.code) || null,
    stderr: clean(child.stderr), gatewayCode: clean(gatewayError?.code) || null,
    gatewayMessage: clean(gatewayError?.message ?? (typeof gatewayError === 'string' ? gatewayError : '')) || null,
    keyMatches: reply?.key === target,
  };
  const receipt = result.sessionCreateCli;
  if (child.status !== 0 || child.error || reply?.ok !== true || gatewayError || !receipt.keyMatches) {
    throw new Error('sessions.create failed (exit ' + (receipt.exitCode ?? receipt.signal ?? receipt.spawnError ?? 'unknown') +
      '): ' + (receipt.gatewayMessage || receipt.stderr || 'missing or unexpected success receipt'));
  }
}

const alertSelector = [
  '[role="alert"]:not([data-active="false"])',
  '.app-toast--error:not([data-active="false"])',
  '.callout.danger', '.agent-chat__composer-alert', '.new-session-page__error',
].join(', ');

function recordAlert(alerts, step, value) {
  const text = scrub(value).trim();
  if (text && !alerts.some(a => a.step === step && a.text === text)) alerts.push({ step, text });
}

async function watchAlerts(page, alerts, step) {
  await page.exposeBinding('__proofRecordAlert', ({ frame }, value) => {
    if (frame === page.mainFrame()) recordAlert(alerts, step(), value);
  });
  await page.addInitScript(selector => {
    let queued = false;
    let previous = new Set();
    function sample() {
      queued = false;
      const current = new Set();
      for (const el of document.querySelectorAll(selector)) {
        if (!el.getClientRects().length || getComputedStyle(el).visibility !== 'visible' ||
            el.closest('[hidden], [inert]')) continue;
        const text = el.innerText?.trim();
        if (!text || current.has(text)) continue;
        current.add(text);
        if (!previous.has(text)) void globalThis.__proofRecordAlert(text).catch(() => {});
      }
      previous = current;
    }
    new MutationObserver(() => {
      if (!queued) { queued = true; requestAnimationFrame(sample); }
    }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'style', 'role', 'hidden', 'inert', 'data-active'] });
    addEventListener('DOMContentLoaded', sample, { once: true });
  }, alertSelector);
}

async function visibleAlerts(page) {
  if (!page || page.isClosed()) return [];
  return page.locator(alertSelector).filter({ visible: true }).evaluateAll(els =>
    els.filter(el => !el.closest('[hidden], [inert]')).map(el => el.innerText.trim()).filter(Boolean))
    .then(texts => [...new Set(texts.map(scrub))]);
}

function classifyError(error, state, setup, step, alerts, now) {
  const status = state?.sttError || state?.captureRejected || state?.closeRejected ? 'ERROR_STT' :
    setup && step !== 'check known parser input' ? 'ERROR_SETUP' : 'FAIL';
  const text = now.length ? now : alerts.filter(a => a.step === step).map(a => a.text);
  if (!state?.violation && text.length &&
      (error instanceof ProofTimeout || error instanceof MissingControl ||
       error?.name === 'TimeoutError' || status === 'ERROR_STT')) {
    return { status: 'ERROR', error: { step, name: 'VisibleUiError', message: text.join(' | ') } };
  }
  return { status, error: { step, ...errorInfo(error) } };
}

async function configurePunctuation(page, policy, receipt) {
  const talk = page.locator('openclaw-talk-settings');
  const prefs = talk.locator('.dictation-refinement-settings fieldset.dictation-punctuation-fields');
  const mode = prefs.locator('select:has(option[value="off"]):has(option[value="automatic"])');
  try {
    await prefs.scrollIntoViewIfNeeded();
    await mode.selectOption(policy);
    assert.equal(await mode.inputValue(), policy, 'punctuation mode did not stick');
    if (policy !== 'off') {
      const language = prefs.locator('select:has(option[value="en-US"])');
      await language.selectOption('en-US');
      assert.equal(await language.inputValue(), 'en-US');
    }
    if (policy === 'explicit') {
      await prefs.getByRole('checkbox', {
        name: 'Allow spoken punctuation commands in Explicit mode', exact: true,
      }).check();
    }
  } finally {
    // Include below-the-fold headings and raw labels, even when the fieldset never mounted.
    Object.assign(receipt, await talk.evaluateAll(roots => {
      const root = roots[0];
      if (!root) return { talkMounted: false };
      const fields = root.querySelector('.dictation-refinement-settings fieldset.dictation-punctuation-fields');
      const select = fields?.querySelector('select:has(option[value="off"]):has(option[value="automatic"])');
      return {
        talkMounted: true,
        headings: [...root.querySelectorAll('h1,h2,h3')].map(el => el.innerText.trim()),
        punctuationMounted: Boolean(fields), legend: fields?.querySelector('legend')?.innerText.trim() ?? null,
        modeLabel: select?.labels?.[0]?.querySelector('span')?.innerText.trim() ?? null,
        mode: select?.value ?? null,
      };
    }).catch(() => ({ domSampleUnavailable: true })));
    for (const field of ['legend', 'modeLabel']) if (typeof receipt[field] === 'string') receipt[field] = scrub(receipt[field]);
    if (receipt.headings) receipt.headings = receipt.headings.map(scrub);
  }
}

function wavMs(file) {
  const b = fs.readFileSync(file);
  assert.ok(b.length >= 44 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE');
  let format = false, bytes = 0;
  for (let i = 12; i + 8 <= b.length; ) {
    const size = b.readUInt32LE(i + 4), from = i + 8;
    assert.ok(from + size <= b.length, 'truncated WAV chunk');
    const kind = b.toString('ascii', i, i + 4);
    if (kind === 'fmt ' && size >= 16) {
      format = b.readUInt16LE(from) === 1 && b.readUInt16LE(from + 2) === 1 &&
        b.readUInt32LE(from + 4) === 48000 && b.readUInt16LE(from + 14) === 16;
    }
    if (kind === 'data') bytes += size;
    i = from + size + (size & 1);
  }
  assert.ok(format && bytes > 0 && bytes <= 30 * 96000 && bytes % 2 === 0, 'expected 48 kHz mono PCM16, at most 30 sec');
  return bytes / 96;
}

async function watchGateway(page, origin, surface, step) {
  const s = { hello: 0, audio: 0, finals: [], events: [], writes: [], closed: false };
  let socketNumber = 0;
  function parse(frame) {
    try { return JSON.parse(frame.toString()); } catch { return null; }
  }
  await page.routeWebSocket(origin.replace(/^http/, 'ws') + '/**', socket => {
    const server = socket.connectToServer();
    const connection = ++socketNumber;
    const pending = new Map();
    socket.onMessage(frame => {
      const m = parse(frame);
      if (m?.type !== 'req') return server.send(frame);
      const p = m.params ?? {};
      if (m.method === 'talk.session.appendAudio' && p.sessionId === s.sid) s.audio++;
      if (m.method === 'talk.session.create' && p.mode === 'transcription') {
        s.allowStandby = false;
        pending.set(m.id, { kind: 'capture', target: p.sessionKey });
      }
      if (m.method === 'talk.session.close' && p.sessionId === s.sid && !p.discard) {
        s.closeRequested = true;
        pending.set(m.id, { kind: 'close' });
      }
      if (submits.has(m.method)) {
        const w = { method: m.method, text: p.message ?? p.question ?? '', target: p.sessionKey ?? p.key };
        s.writes.push(w);
        const empty = !p.attachments?.length && !p.mentions?.length && !p.deliver;
        const draftCreate = m.method === 'sessions.create' && p.agentId === 'main' &&
          w.target === undefined && !p.fork && !p.parentSessionKey;
        if (surface === 'new' && s.allowStandby && !s.standby && draftCreate && !w.text && empty) {
          s.standby = w;
        } else if (s.allow && !s.sent && w.method === s.allow.method && w.text === s.allow.text &&
                   w.target === s.allow.target && empty && (w.method !== 'sessions.create' || draftCreate)) {
          s.sent = w;
        } else {
          w.blocked = true;
          s.violation ??= { method: m.method, step: step() };
          socket.send(JSON.stringify({ type: 'res', id: m.id, ok: false,
            error: { code: 'UNAVAILABLE', message: 'Blocked by dictation proof send guard' } }));
          return;
        }
        pending.set(m.id, { kind: 'write', w });
      }
      server.send(frame);
    });
    server.onMessage(frame => {
      const m = parse(frame);
      if (!m) return socket.send(frame);
      const p = m.payload ?? {};
      if (p.type === 'hello-ok') {
        s.hello++;
        if (p.auth) {
          const scopes = p.auth.scopes ?? [];
          s.hasAuth = true;
          // At the pinned head, operator.write and operator.admin imply operator.talk.
          s.hasTalk = p.auth.role === 'operator' &&
            ['operator.talk', 'operator.write', 'operator.admin'].some(scope => scopes.includes(scope));
        } else {
          s.hasAuth = false;
          s.hasTalk = false;
        }
      }
      if (m.type === 'res' && pending.has(m.id)) {
        const r = pending.get(m.id); pending.delete(m.id);
        if (r.kind === 'capture') {
          s.sid = p.transcriptionSessionId;
          s.target = r.target;
          s.provider = p.provider;
          if (!m.ok) s.captureRejected = scrub(m.error?.message || 'Gateway rejected capture');
        } else if (r.kind === 'close') {
          s.closed = m.ok === true;
          if (!m.ok) s.closeRejected = scrub(m.error?.message || 'Gateway rejected finalization');
        } else {
          const w = r.w;
          w.createdKey = p.key;
          w.error = scrub(m.error?.message || p.runError?.message).slice(0, 1200) || null;
          if (w.method === 'sessions.create') {
            w.runStarted = p.runStarted === true;
            w.accepted = m.ok === true && p.ok === true && typeof p.key === 'string' &&
              p.key.startsWith('agent:main:dashboard:') &&
              p.runError === undefined && p.runStarted === (w !== s.standby);
          } else {
            w.accepted = m.ok === true && !['error', 'timeout', 'rejected'].includes(p.status);
          }
        }
      }
      if (m.event === 'talk.event' && s.sid && p.transcriptionSessionId === s.sid) {
        s.events.push({ connection, type: p.type ?? null, final: p.final ?? p.talkEvent?.final ?? null,
          seq: m.seq ?? null, talkType: p.talkEvent?.type ?? null, talkSeq: p.talkEvent?.seq ?? null,
          textLength: typeof p.text === 'string' ? p.text.length : 0,
          stop: s.stopIssued ? 'after' : 'before' });
        if (p.type === 'transcript' && p.final === true && typeof p.text === 'string' && p.text.trim()) {
          s.finals.push(p.text.trim()); s.laterPartial = false;
        }
        if (p.type === 'partial' || (p.type === 'transcript' && p.final !== true)) {
          s.laterPartial = Boolean(p.text?.trim());
        }
        if (p.type === 'inputAudio') s.audioAccepted = (s.audioAccepted ?? 0) + 1;
        if (p.type === 'close') s.drained = p.reason === 'completed';
        if (p.type === 'error' || (p.type === 'close' && p.reason === 'error')) {
          s.sttError ??= scrub(p.message || 'Transcription provider failed');
        }
      }
      socket.send(frame);
    });
  });
  return s;
}

function checkCaptureTarget(surface, s, target) {
  if (surface === 'main') {
    assert.equal(s.target, target, 'Main dictation targeted the wrong session');
  } else if (surface === 'new' && s.expectStandby) {
    assert.ok(s.standby?.accepted && s.standby.createdKey === s.target,
      'Session-scoped New Session capture did not reuse its accepted empty standby');
  } else {
    assert.equal(s.target, undefined, surface + ' dictation unexpectedly targeted a chat session');
    assert.equal(s.standby, undefined, surface + ' dictation unexpectedly created a standby session');
  }
}

function expectedSubmit(surface, s, target, text) {
  if (surface === 'new' && !s.expectStandby) return { method: 'sessions.create', text, target: undefined };
  return { method: surface === 'side' ? 'sessions.companion.ask' : 'chat.send', text,
    target: surface === 'new' ? s.standby.createdKey : target };
}

async function main() {
  assert.ok(process.platform === 'linux' && key && process.argv.length === 3, 'Linux, OPENAI_API_KEY and one built checkout required');
  const checkout = fs.realpathSync(process.argv[2]);
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
  const head = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  const expectedHead = process.env.PROOF_EXPECTED_HEAD || 'a58e59097da0089adf1a59ba6c86002a2f407bc5';
  assert.match(expectedHead, /^[0-9a-f]{40}$/);
  assert.equal(head, expectedHead, 'build the pinned PR head, not the harness branch or merge ref');
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'tracked checkout is dirty');
  const built = path.join(checkout, 'dist/control-ui');
  assert.ok(fs.existsSync(path.join(built, 'index.html')), 'missing built Control UI');
  const { chromium } = createRequire(path.join(checkout, 'ui/package.json'))('playwright');
  const scenario = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json'), 'utf8'));
  const { refineDictation } = await import(pathToFileURL(path.join(checkout, 'ui/src/lib/dictation-refinement.ts')).href);
  const refine = (rawTranscript, mode, captureId) => refineDictation({
    schemaVersion: 1, captureId, generation: 1, transcriptRevision: 1,
    rawTranscript, isFinal: true, policy: { mode, locale: 'en-US', explicitEnabled: mode === 'explicit' },
    context: { left: draft, right: '' },
  });
  const takes = scenario.takes ?? [];
  const uniqueIds = rows => {
    const seen = new Set();
    for (const { id } of rows) { assert.match(id, runId); assert.ok(!seen.has(id), 'duplicate id'); seen.add(id); }
  };
  uniqueIds(takes); uniqueIds(scenario.cases);
  const clips = scenario.cases.flatMap(c => (takes.length ? takes : [null]).map(take => {
    const name = c.id + (take ? '--' + take.id : '');
    const clip = path.join(__dirname, 'clips', name + '.wav');
    const ms = wavMs(clip);
    assert.ok(ms > scenario.leadingSilenceMs + c.segments.reduce((n, x) => n + x.pauseAfterMs, 0), name + ': clip too short');
    return { ...c, take: take?.id ?? null, voice: take?.voice ?? scenario.tts?.voice ?? null,
      name, clip, ms, hash: sha256(fs.readFileSync(clip)) };
  }));
  assert.ok(clips.length);
  const output = path.join(__dirname, 'results');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const out = fs.mkdtempSync(path.join(output, 'run-'));
  const tmpParent = fs.realpathSync(process.env.PROOF_TMPFS || '/dev/shm');
  assert.equal(fs.statfsSync(tmpParent).type, 0x01021994, 'private runtime must be on Linux tmpfs');
  assert.equal(fs.readFileSync('/proc/swaps', 'utf8').trim().split('\n').length, 1, 'turn off swap before proof');
  const tmp = fs.mkdtempSync(path.join(tmpParent, 'dictation-'));
  const originalTmp = process.env.TMPDIR;
  let gateway;
  const base = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: tmp, TMPDIR: tmp, TEMP: tmp, TMP: tmp,
    XDG_CONFIG_HOME: path.join(tmp, 'config'), XDG_CACHE_HOME: path.join(tmp, 'cache'),
    XDG_DATA_HOME: path.join(tmp, 'data'), XDG_STATE_HOME: path.join(tmp, 'xdg-state') };
  const write = (dir, name, body) => fs.writeFileSync(path.join(dir, name), body, { mode: 0o600 });
  const stop = async () => {
    if (!gateway?.pid || gateway.exitCode !== null || gateway.signalCode !== null) return;
    const done = once(gateway, 'exit');
    process.kill(-gateway.pid, 'SIGTERM');
    const hard = setTimeout(() => { try { process.kill(-gateway.pid, 'SIGKILL'); } catch {} }, 8000);
    await done; clearTimeout(hard);
  };
  const abort = () => { try { if (gateway?.pid) process.kill(-gateway.pid, 'SIGKILL'); } catch {} process.exit(130); };
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    process.env.TMPDIR = tmp;
    for (const d of ['state', 'work', 'worker-tmp']) fs.mkdirSync(path.join(tmp, d), { mode: 0o700 });
    const socket = net.createServer().listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const origin = 'http://127.0.0.1:' + port;
    const config = path.join(tmp, 'openclaw.json');
    const chatModel = process.env.PROOF_CHAT_MODEL || 'openai/gpt-5.4-mini';
    assert.match(chatModel, /^openai\/[a-z0-9.-]+$/);
    fs.writeFileSync(config, JSON.stringify({
      gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token' },
        controlUi: { enabled: true, root: built } },
      logging: { level: 'silent', file: '/dev/null' }, cron: { enabled: false },
      agents: { defaults: { workspace: path.join(tmp, 'work'), model: { primary: chatModel }, models: { [chatModel]: {} } } },
      tools: { profile: 'minimal', media: { audio: { enabled: true, timeoutSeconds: 55 },
        models: [{ provider: 'openai', model: sttModel, capabilities: ['audio'] }] } },
    }), { mode: 0o600 });
    const env = { ...base, OPENCLAW_CONFIG_PATH: config, OPENCLAW_STATE_DIR: path.join(tmp, 'state'),
      OPENCLAW_INTERNAL_WORKER_TMPDIR: path.join(tmp, 'worker-tmp'), OPENCLAW_GATEWAY_TOKEN: token };
    gateway = spawn(process.execPath, ['openclaw.mjs', 'gateway', 'run'], {
      cwd: checkout, env: { ...env, OPENAI_API_KEY: key }, stdio: 'ignore', detached: true,
    });
    gateway.on('error', () => {});
    await until(async () => {
      assert.ok(gateway.pid && gateway.exitCode === null && gateway.signalCode === null, 'Gateway exited during startup');
      try { return (await fetch(origin + '/readyz', { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
    }, 'Gateway readyz timeout', 120000);
    const tally = [];
    for (const c of clips) {
      const folder = path.join(out, c.name); fs.mkdirSync(folder, { mode: 0o700 });
      const { surface, policy, finish, after, words: intended } = c.expect;
      const result = { id: c.id, take: c.take, voice: c.voice, head, tree, chatModel, clipSha256: c.hash, surface, policy, finish, after,
        expectedWords: intended, input: 'Chromium fake mic; synthesized WAV', sttModel, alerts: [] };
      let browser, page, box, field, s, raw = '', phase = 'connect and configure UI', setup = true;
      const capture = async (name, diagnostic = false, subject = box) => {
        if (!page || page.isClosed()) return;
        const body = page.locator('body');
        if (!await body.isVisible()) return;
        if (diagnostic) {
          const alert = page.locator(alertSelector).filter({ visible: true }).last();
          if (await alert.isVisible()) await alert.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
        }
        if (!diagnostic && !(subject && await subject.isVisible())) return;
        // Scan the whole visible document, including toasts that can overlay a crop.
        const screenText = await body.evaluate(el => el.innerText + '\n' +
          [...el.querySelectorAll('input,textarea,[contenteditable="true"]')]
            .filter(e => e.getClientRects().length).map(e => e.value ?? e.innerText).join('\n'), undefined, { timeout: 2000 });
        if (scrubSecrets(screenText) !== screenText) {
          (result.screenshotSkipped ??= []).push({ name, reason: 'possible visible secret' });
          return;
        }
        // Preserve error, alert and status copy. Use the viewport on failure
        // because the alert can be outside, or in place of, the composer.
        const options = { path: path.join(folder, name + '.png'), animations: 'disabled', timeout: 4000 };
        if (diagnostic) await page.screenshot(options);
        else await subject.screenshot(options);
      };
      try {
        phase = 'check known parser input';
        if (policy === 'automatic' || policy === 'explicit') {
          const clean = refine(intended, policy, c.name + '-canary');
          assert.equal(clean.text, 'archive the notes.', 'candidate parser failed the clean positive control');
          assert.equal(clean.status, 'refined');
        }
        phase = 'connect and configure UI';
        browser = await chromium.launch({ env: base, args: ['--disable-breakpad', '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + c.clip + '%noloop'] });
        result.chromium = browser.version();
        const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 920 } });
        await context.grantPermissions(['microphone'], { origin });
        page = await context.newPage(); page.setDefaultTimeout(15000);
        await watchAlerts(page, result.alerts, () => phase);
        s = await watchGateway(page, origin, surface, () => phase);
        await page.goto(origin + '/settings/appearance#token=' + token);
        await until(() => s.hello > 0, 'Control UI handshake', 30000);
        const src = await page.locator('script[type="module"][src]').first().getAttribute('src');
        assert.ok(src);
        const entry = new URL(src, origin);
        assert.equal(entry.origin, origin);
        const asset = path.resolve(built, '.' + entry.pathname);
        assert.ok(asset.startsWith(built + path.sep));
        const response = await fetch(entry);
        assert.ok(response.ok);
        result.uiEntrySha256 = sha256(Buffer.from(await response.arrayBuffer()));
        assert.equal(result.uiEntrySha256, sha256(fs.readFileSync(asset)), 'served JS is not from built checkout');
        await page.locator('[data-test-id="send-shortcut-enter"]').click();
        phase = 'open Talk settings';
        await page.goto(origin + '/settings/talk');
        assert.equal(new URL(page.url()).pathname, '/settings/talk', 'Talk settings route redirected');
        phase = 'configure dictation punctuation';
        result.talkSettings = { route: '/settings/talk' };
        await configurePunctuation(page, policy, result.talkSettings);
        const slug = 'proof-' + c.name.replace('--', '-') + '-' + randomBytes(6).toString('hex');
        const target = 'agent:main:' + slug;
        if (surface !== 'new') {
          phase = 'seed chat session (sessions.create)';
          createProofSession(checkout, env, target, slug, result);
        }
        phase = 'open composer';
        const previousHello = s.hello;
        await page.goto(origin + (surface === 'new' ? '/new' : '/chat/main/' + slug));
        await until(() => s.hello > previousHello, 'composer Gateway handshake', 30000);
        if (surface === 'side') {
          const panels = button(page.locator('.sidebar-region__panels-toggle'), 'Panels');
          if ((await panels.getAttribute('aria-expanded')) !== 'true') await panels.click();
          const launcher = page.locator('.side-panel-launcher:visible').first();
          const add = button(page.locator('[data-region-header="side"]'), 'New tab');
          await launcher.or(add).first().waitFor({ state: 'visible' });
          if (!await launcher.isVisible()) await add.click();
          await launcher.getByRole('button').filter({ has: page.getByText('Side chat', { exact: true }).and(page.locator('.side-panel-type-option__label')) }).click();
        }
        const selector = { main: '.agent-chat__composer-shell', side: '.chat-session-rail__composer',
          new: '.new-session-page__composer' }[surface];
        const label = { main: 'Chat composer', side: 'Ask in side chat',
          new: 'Ask me anything, or hand me something to do' }[surface];
        const textarea = 'textarea[aria-label="' + label + '"]';
        box = page.locator(selector).filter({ has: page.locator(textarea), visible: true }).first();
        field = box.locator(textarea);
        const mic = button(box, /^(Start voice input|Dictate|Dictation)$/);
        phase = 'wait for model and editable composer';
        await field.waitFor();
        const modelSetup = page.getByText('Set up a model', { exact: true }).filter({ visible: true });
        await until(async () => !(await modelSetup.count()) && await field.isEditable() &&
          await mic.isVisible() && await mic.isEnabled(), 'model setup is still required or composer/mic is not ready', 60000);
        await field.fill(draft); await field.press('End');
        const sendButton = () => button(box, { main: /^(Send|Send message)$/, side: 'Ask', new: 'Start session' }[surface]);
        const review = box.getByRole('region', { name: 'Review dictation', exact: true });
        const checkGuard = () => {
          if (s.violation) throw new PrematureSubmit('Blocked ' + s.violation.method + ' at ' + s.violation.step);
        };
        if (surface !== 'main') {
          assert.ok(s.hasAuth, 'composer Gateway hello did not report granted scopes');
          if (surface === 'side') assert.ok(s.hasTalk, 'Side chat proof requires standalone Talk access');
        }
        s.expectStandby = surface === 'new' && !s.hasTalk;
        setup = false; phase = 'start microphone';
        s.allowStandby = s.expectStandby;
        if (surface === 'main') {
          await mic.hover(); await page.mouse.down();
          try { await until(() => s.sid || s.captureRejected || s.violation, 'Main microphone hold was not admitted', 30000); }
          finally { await page.mouse.up(); }
        } else await mic.click();
        await until(() => s.audioAccepted || s.captureRejected || s.sttError || s.violation,
          'no accepted Gateway microphone audio', 30000);
        checkGuard();
        if (s.captureRejected || s.sttError) throw new Error(s.captureRejected || s.sttError);
        assert.equal(s.provider, 'openai', 'wrong transcription provider');
        checkCaptureTarget(surface, s, target);
        await sleep(c.ms + 350); checkGuard();
        phase = 'finish capture';
        const stopButton = button(box, 'Stop and keep text');
        if (finish === 'enter-then-stop') {
          await field.press('Enter'); await sleep(350); checkGuard();
          assert.ok(!s.closeRequested && await stopButton.isEnabled(), 'Main Enter should not finish an active review capture');
        }
        s.stopIssued = true;
        if (finish === 'enter') await field.press('Enter');
        else if (finish === 'send') await button(box, 'Send').click();
        else await stopButton.click();
        await until(() => (s.closed && s.drained) || s.closeRejected || s.sttError || s.violation,
          'Gateway did not finalize and drain transcription', 80000);
        checkGuard();
        if (s.closeRejected || s.sttError) throw new Error(s.closeRejected || s.sttError);
        raw = s.finals.join(' ');
        const recognized = !s.laterPartial && words(raw) === intended;
        const draftWith = text => draft + ' ' + text;
        if (policy === 'off') {
          phase = 'Off direct insertion';
          if (!recognized) { result.status = 'INCONCLUSIVE_STT'; continue; }
          await until(async () => await field.inputValue() === draftWith(raw), 'Off draft did not receive original transcript');
          assert.equal(await review.isVisible(), false, 'Off must not show review');
          checkGuard(); result.status = 'PASS'; continue;
        }
        phase = 'pending review';
        if (!raw || s.laterPartial) {
          await until(async () => await field.isEditable(), 'composer did not unlock after finalization');
          assert.equal(await field.inputValue(), draft, 'incomplete dictation must not modify draft');
          if (!await review.isVisible()) {
            const errors = await visibleAlerts(page);
            for (const text of errors) recordAlert(result.alerts, phase, text);
            if (errors.length) throw new MissingControl('No review was shown');
          }
          result.status = 'INCONCLUSIVE_STT'; continue;
        }
        await review.waitFor();
        assert.equal(await field.inputValue(), draft, 'review must not modify draft');
        assert.equal(await review.getByLabel('Original recognizer text').inputValue(), raw, 'review lost recognizer text');
        const refined = refine(raw, policy, c.name);
        const expected = policy === 'verbatim' ? raw : refined.text;
        const proposed = await review.getByLabel('Proposed text').inputValue();
        assert.equal(proposed, expected, 'review did not use the candidate refinement');
        result.proposed = scrub(proposed);
        result.refinementStatus = refined.status;
        result.refinementReasons = refined.reasons;
        result.distinctRefinement = expected !== raw;
        await capture('review');
        write(folder, 'review-aria.txt', scrub(await review.ariaSnapshot()));
        const send = sendButton();
        result.pendingButton = !await send.isVisible() ? 'hidden' : await send.isDisabled() ? 'disabled' : 'clicked';
        if (result.pendingButton === 'clicked') await send.click();
        result.pendingEnterExercised = surface !== 'new' || after === 'blocked-enter';
        if (result.pendingEnterExercised) await field.press('Enter');
        await sleep(400); checkGuard();
        if (!recognized) { result.status = 'INCONCLUSIVE_STT'; continue; }
        if (policy === 'explicit' && !(refined.edits.some(e => e.reason === 'explicit-punctuation') &&
            words(expected) === 'archive the notes' && expected.endsWith('.'))) {
          result.status = 'INCONCLUSIVE_FIXTURE'; continue;
        }
        if (after === 'blocked-enter') { result.status = 'PASS'; continue; }
        phase = 'Insert';
        await button(review, 'Insert into draft').press('Enter');
        const inserted = draftWith(expected);
        await until(async () => await field.inputValue() === inserted, 'wrong inserted draft');
        checkGuard(); await capture('insert');
        if (after === 'undo') {
          phase = 'Undo';
          await button(box, 'Undo dictation insertion').press('Enter');
          await until(async () => await field.inputValue() === draft, 'Undo did not restore exact draft');
          checkGuard(); result.status = 'PASS'; continue;
        }
        phase = 'explicit submit';
        s.allow = expectedSubmit(surface, s, target, inserted);
        if (after === 'enter') await field.press('Enter');
        else await sendButton().click();
        await until(() => s.violation || s.sent?.accepted !== undefined, 'no completed submit RPC', 150000);
        checkGuard();
        assert.equal(s.sent.accepted, true, s.sent.error || 'Gateway did not acknowledge the explicit submission');
        const turn = (surface === 'side' ? page.locator('.chat-session-rail__thread .chat-group.user') :
          page.locator('.chat-group.user').filter({ visible: true })).getByText(inserted, { exact: true });
        await turn.first().waitFor();
        await sleep(600);
        checkGuard();
        assert.equal(await turn.count(), 1, 'expected one rendered user turn');
        await capture('submitted', false, turn.first());
        result.status = 'PASS';
      } catch (error) {
        const now = await visibleAlerts(page).catch(() => []);
        for (const text of now) recordAlert(result.alerts, phase, text);
        Object.assign(result, classifyError(error, s, setup, phase, result.alerts, now));
      } finally {
        result.finalDraft = await field?.inputValue({ timeout: 500 }).then(scrub, () => null) ?? null;
        const onFailure = Boolean(s?.violation) || result.status !== 'PASS';
        try { await capture(onFailure ? 'diagnostic' : 'final', onFailure); } catch {}
        for (const text of await visibleAlerts(page).catch(() => [])) recordAlert(result.alerts, phase, text);
        try { await browser?.close(); } catch (error) {
          result.status = 'FAIL'; result.error = { step: 'close browser', ...errorInfo(error) };
        }
        // A blocked request always wins, including on the inconclusive exit paths.
        if (s?.violation) {
          result.status = 'FAIL';
          result.error = { step: s.violation.step, ...errorInfo(new PrematureSubmit('Blocked ' + s.violation.method)) };
        }
        result.gatewayEvents = s?.events ?? [];
        result.gatewayError = s?.sttError ?? s?.captureRejected ?? s?.closeRejected ?? null;
        result.gatewayAudioFrames = s?.audio ?? 0;
        result.gatewayAcceptedAudioFrames = s?.audioAccepted ?? 0;
        result.gatewayProvider = s?.provider === 'openai' ? 'openai' : null;
        result.finalAccepted = Boolean(s?.closed && s?.drained);
        result.routing = {
          standaloneTalk: s?.hasAuth ? s.hasTalk : null,
          dictationHasTarget: Boolean(s?.target), expectedStandby: s?.expectStandby ?? null,
          standbyReused: Boolean(s?.standby?.accepted && s.standby.createdKey === s.target),
        };
        result.writes = (s?.writes ?? []).map(w => ({ method: w.method, accepted: w.accepted ?? null,
          blocked: Boolean(w.blocked), nonempty: Boolean(w.text), sameDictationSession: Boolean(w.target && w.target === s.target),
          returnedKey: Boolean(w.createdKey), runStarted: w.runStarted ?? null, error: w.error ?? null }));
        result.screenshotAvailable = fs.readdirSync(folder).some(n => n.endsWith('.png'));
        write(folder, 'transcript.txt', scrub(raw || s?.finals.join(' ')) + '\n');
        write(folder, 'state.json', JSON.stringify(result, null, 2) + '\n');
        tally.push(result);
        console.log(c.name, result.status, result.error?.step ?? '',
          result.status === 'ERROR' ? JSON.stringify(result.error.message) : '');
      }
    }
    write(out, 'summary.json', JSON.stringify(tally, null, 2) + '\n');
    process.exitCode = tally.some(x => x.status === 'FAIL' || x.status.startsWith('ERROR')) ? 1 :
      tally.some(x => x.status.startsWith('INCONCLUSIVE_')) ? 2 : 0;
  } finally {
    try { await stop(); } finally {
      if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp;
      fs.rmSync(tmp, { recursive: true, force: true });
      process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    }
  }
}
main().catch(error => { console.error('Proof setup/cleanup:', JSON.stringify(errorInfo(error))); process.exitCode = 1; });
