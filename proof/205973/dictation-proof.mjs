import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const expectedHead = '268da4f795a65fea0ff7260c9ef8fd25bdc6ef70';
const expectedBefore = '66b2e244acf2666690741d0e04140087b4570100';
const apiKey = process.env.OPENAI_API_KEY?.trim();
delete process.env.OPENAI_API_KEY;
delete process.env.DEBUG;
delete process.env.PWDEBUG;
const exec = promisify(execFile);

class ProofCheck extends Error { name = 'ProofCheck'; }
function check(ok, message) {
  if (!ok) throw new ProofCheck(message);
}
async function until(test, ms, message) {
  const deadline = performance.now() + ms;
  do {
    if (await test()) return;
    await sleep(50);
  } while (performance.now() < deadline);
  throw new ProofCheck(message);
}
// Fixture-only equivalence for these English prose clips, not an insertion normalizer.
// Keep negation, word order, numbers, hyphens, slashes and apostrophes inside words.
const words = (text) => text.normalize('NFC').toLowerCase().replace(/[‘’]/gu, "'")
  .replace(/["“”\x60]/gu, '').replace(/(?<=^|\s)'|'(?=[.,!?;:\s]|$)/gu, '')
  .replace(/[.,!?;:]+(?=\s|$)/gu, '').replace(/\s+/gu, ' ').trim();
const noSend = new Set(['chat.send', 'sessions.send', 'agent']);
const json = (message) => { try { return JSON.parse(String(message)) ?? {}; } catch { return {}; } };
const transcript = (m) => m.finals.join(' ').trim();
const failedStatus = /^(A complete transcript is unavailable\.|This transcript exceeds the text review limit\.)/u;
function blockingNotice(ui, since) {
  const error = (n) => n.kind === 'error';
  return ui.current.find((n) => error(n) && n.inComposer) ??
    ui.current.find(error) ??
    ui.seen.findLast((n) => error(n) && n.lastSeen >= since) ??
    ui.current.find((n) => n.kind === 'status' && failedStatus.test(n.text));
}

// Runs inside the page. Keep short-lived alerts in browser memory until collected.
function installPageProbes() {
  localStorage.setItem('openclaw:control-ui:community-invite:v2',
    JSON.stringify({ dismissedAtMs: Date.now() }));
  const errors = '[role="alert"],.agent-chat__composer-status[data-tone="danger"],'
    + '[data-tone="error"],[data-state="error"],[data-status="error"]';
  const selector = errors + ',[role="status"]';
  const seen = new Map();
  window.readProofNotices = () => {
    const current = [];
    for (const el of document.querySelectorAll(selector)) {
      if (!el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})) continue;
      const text = el.innerText?.trim();
      if (!text) continue;
      const kind = el.matches(errors) ? 'error' : 'status';
      const key = kind + '\0' + text;
      const lastSeen = Date.now();
      const item = { kind, text, inComposer: Boolean(el.closest('.agent-chat__composer-shell')),
        firstSeen: seen.get(key)?.firstSeen ?? lastSeen, lastSeen };
      seen.set(key, item);
      current.push(item);
    }
    return { current, seen: [...seen.values()] };
  };
  new MutationObserver(window.readProofNotices).observe(document, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['role', 'class', 'style', 'hidden', 'open', 'data-tone', 'data-state', 'data-status']
  });
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.proofMic = { tracks: [], openedAt: null };
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await original(constraints);
    const tracks = stream.getAudioTracks();
    window.proofMic.tracks.push(...tracks);
    if (tracks.length) window.proofMic.openedAt ??= performance.now();
    return stream;
  };
}

const visibleButton = (scope, name) => scope.getByRole('button', { name, exact: true })
  .filter({ visible: true });

async function startDictation(page, shell, ready, recordGesture) {
  const mobile = visibleButton(shell, 'Dictation');
  const desktop = visibleButton(shell, 'Start voice input');
  await mobile.or(desktop).waitFor();
  if (await mobile.isVisible()) {
    recordGesture('mobile-click');
    await mobile.click();
    await ready();
    return;
  }
  recordGesture('desktop-hold');
  // Desktop tap opens Talk. Hold until the app has latched or reported startup failure.
  await desktop.hover();
  await page.mouse.down();
  try { await ready(); } finally { await page.mouse.up(); }
}

// Read RIFF chunks rather than assuming a 44-byte header.
function wavMs(wav) {
  check(wav.length >= 44 && wav.toString('ascii', 0, 4) === 'RIFF' &&
    wav.toString('ascii', 8, 12) === 'WAVE', 'Expected a RIFF WAV');
  let format = false, bytes = 0;
  for (let i = 12; i + 8 <= wav.length;) {
    const tag = wav.toString('ascii', i, i + 4);
    const n = wav.readUInt32LE(i + 4);
    const j = i + 8;
    check(j + n <= wav.length, 'Truncated WAV chunk');
    if (tag === 'fmt ' && n >= 16) {
      format = wav.readUInt16LE(j) === 1 && wav.readUInt16LE(j + 2) === 1 &&
        wav.readUInt32LE(j + 4) === 48000 && wav.readUInt16LE(j + 14) === 16;
    }
    if (tag === 'data') bytes += n;
    i = j + n + (n % 2);
  }
  check(format && bytes > 0 && bytes % 2 === 0, 'Expected 48 kHz mono 16-bit PCM');
  return bytes / 96;
}

async function freePort() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function eventEvidence(m, direction, type, frame = {}, payload = {}) {
  const seq = payload.talkEvent?.seq;
  m.events.push({ direction, type,
    final: typeof payload.final === 'boolean' ? payload.final : null,
    seq: Number.isSafeInteger(seq) ? seq : null,
    gatewaySeq: Number.isSafeInteger(frame.seq) ? frame.seq : null,
    textLength: typeof payload.text === 'string' ? payload.text.length : null,
    stopPhase: m.stopIssued ? 'after-stop' : 'before-stop',
    ...(typeof frame.ok === 'boolean' ? { ok: frame.ok } : {}),
    ...(Number.isSafeInteger(payload.byteLength) ? { audioBytes: payload.byteLength } : {}),
    ...(type === 'close' ? { completed: payload.reason === 'completed' } : {})
  });
}

async function observe(page, origin, m, stage) {
  await page.routeWebSocket((url) => url.origin === origin.replace('http:', 'ws:'), (browser) => {
    const gateway = browser.connectToServer();
    let createId, sessionId, seq = 0, lastFinalTurn;
    browser.onMessage((message) => {
      const { type, method, id, params } = json(message);
      if (type === 'req' && noSend.has(method)) {
        m.blocked.push(method); m.blockedAt ??= stage(); return;
      }
      if (method === 'talk.session.create' && params?.mode === 'transcription') {
        createId = id;
        seq = 0; lastFinalTurn = undefined;
        eventEvidence(m, 'request', method);
      }
      if (method === 'talk.session.close' && sessionId && params?.sessionId === sessionId) {
        eventEvidence(m, 'request', params.discard ? method + ':discard' : method);
        if (params.discard) m.discards++;
        else m.finishAt = performance.now();
      }
      gateway.send(message);
    });
    gateway.onMessage((message) => {
      const f = json(message), p = f.payload;
      if (f.type === 'res' && createId && f.id === createId) {
        eventEvidence(m, 'response', 'talk.session.create', f);
        m.createRejected = !f.ok;
        sessionId = f.ok ? p?.transcriptionSessionId : undefined;
        m.relayProvider = sessionId && p.transport === 'gateway-relay' &&
          p.mode === 'transcription' && p.brain === 'none' ? p.provider : undefined;
        m.openaiRelay = m.relayProvider === 'openai';
      }
      if (f.event === 'talk.event' && sessionId && p?.transcriptionSessionId === sessionId) {
        eventEvidence(m, 'event', typeof p.type === 'string' ? p.type : 'unknown', f, p);
      }
      if (f.event === 'talk.event' && sessionId && p?.transcriptionSessionId === sessionId && !m.close) {
        if (p.type === 'inputAudio' && Number.isSafeInteger(p.byteLength)) m.audioBytes += p.byteLength;
        const e = p.talkEvent;
        if (!e || (e.sessionId === sessionId && Number.isSafeInteger(e.seq) && e.seq > seq)) {
          if (e) seq = e.seq;
          const turn = typeof e?.turnId === 'string' ? e.turnId : undefined;
          if ((p.type === 'transcript' || p.type === 'partial') && typeof p.text === 'string' &&
              (!turn || turn !== lastFinalTurn)) {
            const text = p.text.trim();
            if (p.type === 'transcript' && p.final === true) {
              if (text) { m.finals.push(text); m.partial = ''; lastFinalTurn = turn; }
            } else m.partial = text;
          }
          if (p.type === 'error') m.providerError = true;
          if (p.type === 'close') m.close = { completed: p.reason === 'completed', at: performance.now() };
        }
      }
      browser.send(message);
    });
  });
}

async function runCase({ c, take, clip, out, ram, checkout, chromium, build, scenario }) {
  let dir;
  const gatewayToken = randomBytes(32).toString('hex');
  const safe = (text) => String(text).replaceAll(apiKey, '[REDACTED]')
    .replaceAll(gatewayToken, '[REDACTED]').replace(/\bsk-[\w-]{8,}/gu, '[REDACTED]')
    .replace(/([?&#]|\b)([\w-]*(?:token|password|api[_-]?key)[\w-]*)=[^\s&#"']+/giu, '$1$2=[REDACTED]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]');
  const report = { id: c.id, take: take?.id ?? null, route: c.route, action: c.action, head: build.commit,
    buildId: build.buildId, clip: path.basename(clip),
    ttsModel: scenario.tts.model, ttsVoice: take?.voice ?? scenario.tts.voice,
    microphone: 'Chromium fake microphone, prerecorded OpenAI TTS; not physical input',
    requestedSttModel: c.route === 'file' ? 'gpt-4o-mini-transcribe' : 'gpt-4o-transcribe',
    expectedText: c.expectedText, stage: 'read-clip', result: 'ERROR_SETUP', screenshots: [] };
  let gateway, exited, browser, page, shell, draft, preview, status;
  const m = { audioBytes: 0, blocked: [], finals: [], partial: '', discards: 0, events: [] };
  let since = Date.now();
  const step = (name) => { report.stage = name; since = Date.now(); };
  const inconclusive = (name, message) => {
    report.result = 'INCONCLUSIVE_STT';
    report.failure = { step: report.stage, name, message };
  };
  let bootFragmentSecrets = [];
  const redact = (text) => bootFragmentSecrets.reduce((s, secret) =>
    s.replaceAll(secret, '[REDACTED]'), safe(text));
  const notices = async () => (await page?.evaluate(() => window.readProofNotices?.())
    .catch(() => null)) ?? { current: [], seen: [] };
  const findError = async (waitMs = 0) => {
    const deadline = performance.now() + waitMs;
    do {
      const notice = blockingNotice(await notices(), since);
      if (notice) return notice;
      if (!page || performance.now() >= deadline) return undefined;
      await sleep(50);
    } while (true);
  };
  const picture = async (name, wholePage = false) => {
    if (!page || page.isClosed()) return;
    try {
      if (!wholePage && !await shell?.isVisible()) return;
      const rendered = await page.evaluate(() => [document.body?.innerText ?? '',
        ...Array.from(document.querySelectorAll('input, textarea'), (el) => el.value)].join('\n'));
      // Never mask UI. If a credential is rendered, withhold this image.
      if (redact(rendered) !== rendered) {
        report.artifactWarning = 'Withheld ' + name + ': potential credential in the page';
        return;
      }
      const options = { path: path.join(out, name + '.png'), animations: 'disabled', timeout: 2000 };
      if (wholePage) await page.screenshot(options);
      else await shell.screenshot(options);
      report.screenshots.push(name + '.png');
    } catch { report.artifactWarning = 'Could not capture ' + name; }
  };
  const markUiError = async (notice) => {
    report.result = 'ERROR';
    report.failure = { step: report.stage, name: 'VisibleUiError', message: redact(notice.text) };
    await picture('error', true);
  };
  const preserved = async () => {
    check(!m.blocked.length, 'An outbound send/agent request was blocked');
    check(await draft.inputValue() === c.initialDraft, 'Draft changed without acceptance');
  };
  try {
    const wav = await readFile(clip);
    const duration = wavMs(wav);
    check(duration > scenario.leadingSilenceMs && duration < 30_000, 'Clip outside test duration');
    report.clipMs = Math.round(duration);
    await writeFile(path.join(out, 'clip.sha256'), createHash('sha256').update(wav).digest('hex') + '\n');
    step('gateway-startup');
    dir = await mkdtemp(path.join(ram, 'case-'));
    const port = await freePort();
    const origin = 'http://127.0.0.1:' + port;
    await mkdir(path.join(dir, 'home'));
    await mkdir(path.join(dir, 'tmp'));
    const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: path.join(dir, 'home'),
      TMPDIR: path.join(dir, 'tmp'), TMP: path.join(dir, 'tmp'), TEMP: path.join(dir, 'tmp') };
    const gwEnv = { ...env, OPENCLAW_STATE_DIR: path.join(dir, 'state'),
      OPENCLAW_CONFIG_PATH: path.join(dir, 'openclaw.json'), OPENCLAW_GATEWAY_TOKEN: gatewayToken,
      OPENCLAW_INTERNAL_WORKER_TMPDIR: env.TMPDIR, OPENCLAW_DISABLE_BONJOUR: '1' };
    await writeFile(gwEnv.OPENCLAW_CONFIG_PATH, JSON.stringify({
      gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token' },
        controlUi: { enabled: true, root: path.join(checkout, 'dist/control-ui') } },
      agents: { defaults: { workspace: path.join(dir, 'workspace'),
        model: { primary: 'openai/gpt-5.4-mini' }, models: { 'openai/gpt-5.4-mini': {} },
        ...(c.route === 'realtime' ? { voiceModel: 'openai/gpt-4o-transcribe' } : {}) } },
      ...(c.route === 'file' ? { tools: { media: { audio: { enabled: true }, models: [
        { provider: 'openai', model: 'gpt-4o-mini-transcribe', capabilities: ['audio'] }
      ] } } } : {}),
      plugins: { allow: ['openai'] }, models: { catalogRefresh: { enabled: false } },
      update: { checkOnStart: false }, cron: { enabled: false }, browser: { enabled: false },
      logging: { file: path.join(dir, 'gateway.log'), level: 'warn' }
    }), { mode: 0o600 });
    const entry = path.join(checkout, 'openclaw.mjs');
    gateway = spawn(process.execPath, [entry, 'gateway', 'run'], {
      cwd: dir, env: { ...gwEnv, OPENAI_API_KEY: apiKey }, detached: true, stdio: 'ignore'
    });
    let done = false;
    exited = new Promise((resolve) => {
      const finish = () => { done = true; resolve(true); };
      gateway.once('exit', finish);
      gateway.once('error', finish);
    });
    await until(async () => {
      check(!done, 'Gateway exited before readiness');
      const res = await fetch(origin + '/readyz', { signal: AbortSignal.timeout(1000) }).catch(() => null);
      await res?.body?.cancel();
      return res?.ok;
    }, 120_000, 'Gateway did not reach /readyz');

    const cli = async (args) => JSON.parse((await exec(process.execPath, [entry, ...args], {
      cwd: dir, env: gwEnv, encoding: 'utf8', timeout: 30_000
    })).stdout);
    step('prove-transcription-route');
    const catalog = (await cli(['gateway', 'call', 'talk.catalog', '--json', '--timeout', '15000'])).transcription;
    const source = c.route === 'file' ? 'media-understanding' : 'voice-model';
    check(catalog?.ready && catalog.source === source && catalog.activeProvider === 'openai',
      'Talk catalog did not select the requested OpenAI path');
    report.transcriptionSource = source;

    step('connect-control-ui');
    const { browserUrl } = await cli(['dashboard', '--json']);
    const url = new URL(browserUrl);
    const fragment = new URLSearchParams(url.hash.slice(1));
    check(url.origin === origin && fragment.get('gatewayUrl') === 'ws://127.0.0.1:' + port,
      'Dashboard handoff did not target this loopback Gateway');
    bootFragmentSecrets = [...fragment]
      .filter(([key, value]) => /token|password/i.test(key) && value).map(([, value]) => value);
    url.pathname = '/chat';
    browser = await chromium.launch({ headless: true, env,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--use-file-for-fake-audio-capture=' + clip + '%noloop'] });
    const viewport = { width: 1440, height: 1000 };
    report.viewport = viewport;
    const context = await browser.newContext({ locale: 'en-US', permissions: ['microphone'],
      viewport, colorScheme: 'dark', reducedMotion: 'reduce' });
    page = await context.newPage();
    page.setDefaultTimeout(8_000);
    await observe(page, origin, m, () => report.stage);
    await page.addInitScript(installPageProbes);
    await page.goto(url.href);
    await page.waitForFunction(() => window.openclawControlUi?.snapshot().gatewayPhase === 'connected',
      undefined, { timeout: 30_000 });
    shell = page.locator('.agent-chat__composer-shell');
    draft = shell.locator('textarea[aria-label="Chat composer"]');
    const review = shell.locator('.agent-chat__dictation-refinement');
    const button = visibleButton;
    status = review.getByRole('status');
    preview = review.getByRole('textbox', { name: 'Text preview', exact: true });

    step('composer-model-ready');
    const setup = page.getByText('Set up a model', { exact: true });
    await until(async () => await draft.count() === 1 && await draft.isVisible() &&
      await draft.isEnabled() && !(await Promise.all((await setup.all()).map((el) => el.isVisible()))).some(Boolean),
      30_000, 'Composer did not become enabled without the model setup banner');
    report.result = 'FAIL';
    step('opt-in');
    await draft.fill(c.initialDraft);
    await button(shell, 'Dictation text options').click();
    const optIn = review.getByRole('checkbox', { name: 'Review dictated text before inserting' });
    check(!await optIn.isChecked(), 'Review was not off by default');
    await optIn.check();
    await draft.press('End');

    step('capture');
    const listening = shell.locator('.agent-chat__dictation-status [data-status="listening"]');
    await startDictation(page, shell, () => until(
      async () => m.providerError || m.createRejected || await listening.isVisible(),
      8_000, 'Dictation did not enter listening'), (gesture) => { report.captureGesture = gesture; });
    if (m.createRejected) report.result = 'ERROR_SETUP';
    check(m.openaiRelay, 'No successful OpenAI transcription relay admission');
    check(!m.providerError, 'OpenAI relay reported an error before capture');
    await page.waitForFunction((ms) => window.proofMic.openedAt !== null &&
      performance.now() - window.proofMic.openedAt >= ms, duration + 200,
      { timeout: Math.ceil(duration) + 6_000 });
    // The browser delivers 8 kHz mu-law to the Gateway, one byte per sample.
    check(m.audioBytes >= Math.max(1, (duration - 300) * 8), 'Gateway did not receive enough audio');
    await preserved();
    if (c.route === 'file') check(m.finals.length === 0, 'File STT finalized before Stop');
    if (c.action === 'cancel-finishing') {
      // Get live recognizer evidence before the action intentionally discards it.
      await until(() => m.finals.length > 0, 3_000, 'No pre-Stop final').catch(() => {});
    }
    step('stop');
    const stop = button(shell, 'Finish and review text')
      .and(shell.locator('.chat-send-btn--dictation-commit'));
    await stop.waitFor();
    // Evidence boundary: dispatch of the Stop click, before its Gateway close RPC.
    m.stopIssued = true;
    await stop.click();
    const stopped = performance.now();
    await page.waitForFunction(() => window.proofMic.tracks.length > 0 &&
      window.proofMic.tracks.every((track) => track.readyState === 'ended'), undefined, { timeout: 1000 });
    report.tracksEndedAfterStop = true;
    await preserved();
    const statusIs = async (text) => (await status.count()) === 1 && (await status.innerText()) === text;
    if (c.route === 'realtime') {
      await until(() => statusIs('Finishing text. The microphone is off.'), 1_000, 'Missing realtime finishing state');
      check(!m.close && await preview.count() === 0, 'Review did not wait for realtime close');
      if (c.action !== 'cancel-finishing') await picture('finishing');
    }

    if (c.action === 'cancel-finishing') {
      step('cancel-finishing');
      await until(() => m.finishAt !== undefined, 1_000, 'No normal close request before Cancel');
      const beforeCancel = transcript(m);
      await button(review, 'Cancel text refinement').click();
      await until(() => statusIs('Text refinement cancelled. Your draft is preserved.'),
        1_000, 'Missing cancellation confirmation');
      await until(() => m.discards > 0 && m.close, 6_000, 'No cancellation/close receipt');
      check(m.close.completed, 'Cancelled relay did not close normally');
      // Observe through the ordinary realtime drain window, not just the click.
      await sleep(Math.max(0, stopped + 5_500 - performance.now()));
      check(await preview.count() === 0, 'Cancelled preview resurfaced');
      await preserved();
      report.recognizedBeforeCancel = words(beforeCancel) === words(c.expectedText);
      report.cancelPreservedDraft = true;
      if (report.recognizedBeforeCancel) report.result = 'PASS';
      else inconclusive('TranscriptMismatch', 'No matching final transcript before Cancel');
    } else {
      step('provider-finalization');
      await until(() => m.close || m.providerError, 15_000, 'Gateway did not report terminal close');
      await preserved();
      const raw = transcript(m);
      report.sttWordsMatch = words(raw) === words(c.expectedText);
      const late = m.finishAt !== undefined && m.close && m.close.at - m.finishAt >= 10_000;
      if (m.providerError || !m.close?.completed || m.partial || late || !report.sttWordsMatch) {
        const alert = await findError(m.providerError || m.close?.completed === false ? 750 : 0);
        if (alert?.kind === 'error' && !await preview.isVisible()) await markUiError(alert);
        else inconclusive(m.providerError || !m.close?.completed || m.partial || late ? 'TranscriptionUnavailable' : 'TranscriptMismatch',
          'Live STT did not return a complete final transcript with the intended words');
      } else {
        step('review');
        await preview.waitFor();
        check(await preview.evaluate((el) => el.readOnly), 'Preview is editable');
        check(await preview.inputValue() === raw, 'Review changed or lost finalized STT text');
        await review.getByText('Inspect changes', { exact: true }).click();
        const original = review.getByRole('textbox', { name: 'Original finalized transcript' });
        check(await original.inputValue() === raw, 'Inspection did not show the wire transcript');
        await preserved();
        await picture('review');
        step('explicit-insertion');
        await button(review, c.action === 'keep-raw' ? 'Keep raw transcript' : 'Use reviewed text').click();
        await preview.waitFor({ state: 'detached' });
        const space = /^[,.;:!?)]/.test(raw) ? '' : ' ';
        check(await draft.inputValue() === c.initialDraft + space + raw, 'Expected one exact insertion');
        check(!m.blocked.length, 'An outbound send/agent request was blocked');
        report.result = 'PASS';
      }
    }
    if (report.result === 'PASS') step('complete');
  } catch (error) {
    // Keep the underlying action error alongside any visible notice, not the raw call log.
    const cause = { name: redact(error?.name ?? 'Error'),
      message: redact(String(error?.message ?? error).split(/\r?\n/u, 1)[0]).slice(0, 400) };
    const alert = await findError(m.providerError || m.createRejected ? 750 : 0);
    if (alert) {
      await markUiError(alert);
      report.failure.cause = cause;
    } else if (report.stage === 'capture' && m.providerError &&
        await draft.inputValue({ timeout: 1000 }).catch(() => null) === c.initialDraft) {
      inconclusive('TranscriptionUnavailable', 'OpenAI relay reported an error during capture');
    } else report.failure = { step: report.stage, ...cause };
  } finally {
    const ui = await notices();
    const redactNotice = (n) => ({ ...n, text: redact(n.text) });
    report.visibleNotices = ui.current.map(redactNotice);
    report.noticeHistory = ui.seen.map(redactNotice);
    try {
      report.finalDraft = draft ? redact(await draft.inputValue({ timeout: 1000 })) : null;
      report.reviewStatus = status && await status.count() ? redact(await status.innerText()) : null;
      report.previewPresent = preview ? await preview.count() > 0 : null;
    } catch { report.artifactWarning = 'Could not read the final composer state'; }
    await picture('final', report.result === 'ERROR' || ui.current.some((n) => n.kind === 'error'));
    if (!report.screenshots.includes('final.png') && !report.artifactWarning) {
      report.artifactWarning = 'Final composer was not visible or capture was withheld';
    }
    report.audioBytes = m.audioBytes;
    report.discardRequests = m.discards;
    report.createRejected = m.createRejected ?? null;
    report.providerError = m.providerError ?? false;
    report.unfinishedCaption = Boolean(m.partial);
    report.terminalClose = m.close?.completed ?? null;
    report.finishRpcToCloseMs = m.finishAt !== undefined && m.close
      ? Math.round(m.close.at - m.finishAt) : null;
    try {
      try { await browser?.close(); } finally {
        if (gateway?.pid) {
          const signal = (name) => {
            try { process.kill(-gateway.pid, name); } catch (e) { if (e.code !== 'ESRCH') throw e; }
          };
          signal('SIGTERM');
          await Promise.race([exited, sleep(5000, null, { ref: false })]);
          signal('SIGKILL');
          await exited;
        }
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    } catch {
      if (report.result === 'PASS') report.result = 'ERROR_SETUP';
      report.failure ??= { step: 'cleanup', name: 'CleanupError', message: 'Could not clean up isolated runtime' };
    }
    report.gatewayEvents = m.events.map((event) => ({ ...event, type: redact(event.type) }));
    report.blockedRequests = m.blocked;
    if (m.blocked.length) {
      report.result = 'FAIL';
      report.failure = { step: m.blockedAt ?? report.stage, name: 'UnexpectedSend',
        message: 'Blocked outbound requests: ' + m.blocked.join(', ') };
    } else if (report.result === 'PASS' && report.artifactWarning) {
      report.result = 'ERROR_ARTIFACT';
      report.failure = { step: 'artifacts', name: 'ArtifactError', message: report.artifactWarning };
    }
    await writeFile(path.join(out, 'transcript.txt'), redact(transcript(m)) + '\n');
    await writeFile(path.join(out, 'state.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return report.result;
}

// External STT fixture only: the built UI, microphone transport, Deepgram plugin,
// Gateway relay and draft owner all run normally. No live provider credentials.
async function comparisonSpeech(checkout) {
  const { WebSocket, WebSocketServer } = createRequire(path.join(checkout, 'package.json'))('ws');
  const http = createHttpServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ server: http, path: '/v1/listen' });
  const attempts = [];
  const partial = 'Do not delete';
  const final = 'Do not delete customer_id or -12 mg.';
  wss.on('connection', (socket) => {
    socket.on('error', () => {}); // A discarded capture may close mid-frame.
    const result = (text, isFinal) => socket.send(JSON.stringify({ type: 'Results',
      is_final: isFinal, from_finalize: isFinal, channel: { alternatives: [{ transcript: text }] } }));
    const attempt = { bytes: 0, finishing: false, released: false, closed: false,
      release() {
        check(this.finishing && !this.released && socket.readyState === WebSocket.OPEN,
          'Fixture provider was not waiting for a final');
        this.released = true;
        result(final, true);
      } };
    attempts.push(attempt);
    socket.on('message', (data, binary) => {
      if (binary) {
        const first = attempt.bytes === 0;
        attempt.bytes += data.length;
        if (first && attempt.bytes) result(partial, false);
      } else if (json(data).type === 'Finalize') attempt.finishing = true;
    });
    socket.on('close', () => { attempt.closed = true; });
  });
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  return { attempts, partial, final, baseUrl: 'http://127.0.0.1:' + http.address().port + '/v1',
    async close() {
      const closed = new Promise((resolve) => wss.close(resolve));
      for (const socket of wss.clients) socket.terminate();
      await closed;
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    } };
}

async function runComparison({ side, viewport, checkout, build, chromium, ram, out }) {
  const baseline = side === 'before';
  const dir = await mkdtemp(path.join(ram, side + '-'));
  const token = randomBytes(32).toString('hex');
  const fixtureKey = 'synthetic-dictation-proof-key';
  const secrets = [token, fixtureKey];
  const redact = (text) => secrets.reduce((s, value) => s.replaceAll(value, '[REDACTED]'), String(text))
    .replace(/\bsk-[\w-]{8,}/gu, '[REDACTED]')
    .replace(/([?&#]|\b)([\w-]*(?:token|password|api[_-]?key)[\w-]*)=[^\s&#"']+/giu, '$1$2=[REDACTED]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [REDACTED]');
  const report = { side, commit: build.commit, buildId: build.buildId, viewport, scale: 1,
    theme: 'dark', locale: 'en-US', route: 'realtime', result: 'ERROR_SETUP',
    boundary: 'Built Control UI and real Gateway; Chromium fake mic and synthetic loopback Deepgram',
    liveProvider: false, physicalMicrophone: false, screenshots: [] };
  const m = { blocked: [], events: [], finals: [], audioBytes: 0, discards: 0 };
  const frames = [];
  const initialDraft = 'Existing draft.';
  let stage = 'startup', speech, gateway, exited, browser, page, draft;
  const safeUi = async () => {
    const rendered = await page.evaluate(() => [document.body?.innerText ?? '',
      ...Array.from(document.querySelectorAll('input, textarea'), (el) => el.value)].join('\n'));
    check(redact(rendered) === rendered, 'Withheld frame: possible credential in the page');
  };
  const snap = async (name, focus, label) => {
    await safeUi();
    const box = focus ? await focus.boundingBox({ timeout: 1000 }) : null;
    const x = Math.max(1, Math.floor(box?.x ?? 1));
    const y = Math.max(1, Math.floor(box?.y ?? 1));
    const right = Math.min(viewport.width - 1, Math.ceil((box?.x ?? 0) + (box?.width ?? 0)));
    const bottom = Math.min(viewport.height - 1, Math.ceil((box?.y ?? 0) + (box?.height ?? 0)));
    check(!focus || (box && right > x && bottom > y), 'Annotation target is outside the viewport');
    const png = await page.screenshot({ scale: 'css', animations: 'disabled', timeout: 2000 });
    await safeUi();
    frames.push({ name, png, outline: focus ? { x, y, width: right - x, height: bottom - y, label } : null });
  };
  try {
    speech = await comparisonSpeech(checkout);
    const port = await freePort();
    const origin = 'http://127.0.0.1:' + port;
    const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: dir, TMPDIR: dir, TMP: dir, TEMP: dir };
    const gwEnv = { ...env, OPENCLAW_STATE_DIR: path.join(dir, 'state'),
      OPENCLAW_CONFIG_PATH: path.join(dir, 'config.json'), OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_INTERNAL_WORKER_TMPDIR: dir, OPENCLAW_DISABLE_BONJOUR: '1',
      DEEPGRAM_API_KEY: fixtureKey, DEEPGRAM_BASE_URL: speech.baseUrl };
    await writeFile(gwEnv.OPENCLAW_CONFIG_PATH, JSON.stringify({
      gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token' },
        controlUi: { enabled: true, root: path.join(checkout, 'dist/control-ui') } },
      agents: { defaults: { workspace: path.join(dir, 'workspace'),
        model: 'dictation-fixture/metadata', modelPolicy: { allow: ['dictation-fixture/*'] },
        voiceModel: 'deepgram/nova-3' } },
      models: { catalogRefresh: { enabled: false }, providers: { 'dictation-fixture': {
        api: 'openai-responses', apiKey: fixtureKey, baseUrl: speech.baseUrl,
        request: { allowPrivateNetwork: true }, models: [{ id: 'metadata', name: 'Fixture' }] } } },
      plugins: { allow: ['deepgram', 'openai'] }, cron: { enabled: false },
      browser: { enabled: false }, update: { checkOnStart: false },
      logging: { file: path.join(dir, 'gateway.log'), level: 'warn' }
    }), { mode: 0o600 });
    const entry = path.join(checkout, 'openclaw.mjs');
    gateway = spawn(process.execPath, [entry, 'gateway', 'run'], {
      cwd: dir, env: gwEnv, detached: true, stdio: 'ignore' });
    let done = false;
    exited = new Promise((resolve) => {
      const finish = () => { done = true; resolve(); };
      gateway.once('exit', finish); gateway.once('error', finish);
    });
    await until(async () => {
      check(!done, 'Comparison Gateway exited before readiness');
      const res = await fetch(origin + '/readyz', { signal: AbortSignal.timeout(1000) }).catch(() => null);
      await res?.body?.cancel();
      return res?.ok;
    }, 120_000, 'Comparison Gateway did not reach /readyz');
    const { stdout } = await exec(process.execPath, [entry, 'dashboard', '--json'],
      { cwd: dir, env: gwEnv, encoding: 'utf8', timeout: 30_000 });
    const url = new URL(JSON.parse(stdout).browserUrl);
    const fragment = new URLSearchParams(url.hash.slice(1));
    check(url.origin === origin && fragment.get('gatewayUrl') === 'ws://127.0.0.1:' + port,
      'Dashboard handoff did not target this loopback Gateway');
    for (const [key, value] of fragment) if (/token|password/i.test(key) && value) secrets.push(value);
    url.pathname = '/chat';
    browser = await chromium.launch({ headless: true, env, args: ['--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream', '--disable-partial-raster', '--disable-gpu-rasterization'] });
    const context = await browser.newContext({ locale: report.locale, permissions: ['microphone'], viewport,
      deviceScaleFactor: 1, colorScheme: report.theme, reducedMotion: 'reduce' });
    page = await context.newPage();
    page.setDefaultTimeout(8000);
    await observe(page, origin, m, () => stage);
    await page.addInitScript(installPageProbes);
    await page.goto(url.href);
    await page.waitForFunction(() => window.openclawControlUi?.snapshot().gatewayPhase === 'connected',
      undefined, { timeout: 30_000 });
    const shell = page.locator('.agent-chat__composer-shell');
    draft = shell.locator('.agent-chat__composer-combobox textarea');
    const review = shell.locator('.agent-chat__dictation-refinement');
    const status = review.getByRole('status');
    const preview = review.getByRole('textbox', { name: 'Text preview', exact: true });
    const caption = review.getByRole('textbox', { name: 'Provisional caption', exact: true });
    const idle = visibleButton(shell, 'Dictation').or(visibleButton(shell, 'Start voice input'));
    stage = 'idle';
    await draft.fill(initialDraft, { timeout: 30_000 });
    await idle.waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await snap('idle', draft, 'Same initial draft');
    const gear = visibleButton(shell, 'Dictation text options');
    if (baseline) check(await gear.count() === 0, 'Base unexpectedly exposes review');
    else {
      await gear.click();
      const optIn = review.getByRole('checkbox', { name: 'Review dictated text before inserting' });
      check(!await optIn.isChecked(), 'Review was not off by default');
      await snap('opt-in', optIn, 'Review is opt-in');
      await optIn.check();
      // Collapse settings so both captures show the dictation flow, not a menu.
      await gear.click();
    }
    const noSends = () => check(!m.blocked.length, 'Unexpected outbound send or agent request');
    const draftIs = (value) => until(async () => await draft.inputValue() === value,
      5_000, 'Expected draft did not settle');
    const statusIs = (value) => until(async () => await status.innerText() === value,
      5_000, 'Expected review status did not appear');
    const start = async () => {
      const index = speech.attempts.length;
      Object.assign(m, { stopIssued: false, close: undefined, finishAt: undefined,
        relayProvider: undefined, createRejected: false, providerError: false, partial: '', finals: [] });
      const listening = shell.locator('.agent-chat__dictation-status [data-status="listening"]');
      await draft.press('End');
      await startDictation(page, shell, () => listening.waitFor(), () => {});
      await until(() => speech.attempts[index]?.bytes > 0 && m.partial === speech.partial,
        8_000, 'No fixture audio and partial reached the composer');
      check(m.relayProvider === 'deepgram', 'Expected the loopback Deepgram relay');
      return speech.attempts[index];
    };
    const stop = async (attempt) => {
      const control = baseline
        ? visibleButton(shell, 'Stop and keep text').and(shell.locator('button.chat-send-btn--dictating'))
        : visibleButton(shell, 'Finish and review text').and(shell.locator('button.chat-send-btn--dictation-commit'));
      m.stopIssued = true;
      await control.click();
      await until(() => attempt.finishing, 2_000, 'Fixture did not receive Finalize');
      await page.waitForFunction(() => window.proofMic.tracks.length > 0 &&
        window.proofMic.tracks.every((track) => track.readyState === 'ended'), undefined, { timeout: 1000 });
      noSends();
    };
    report.result = 'FAIL';
    stage = 'recording';
    const attempt = await start();
    if (baseline) await draftIs(initialDraft + ' ' + speech.partial);
    else {
      await until(async () => await caption.inputValue() === speech.partial, 3_000, 'Missing provisional caption');
      await draftIs(initialDraft);
    }
    await snap('recording', baseline ? draft : caption,
      baseline ? 'Partial text is in the draft' : 'Partial text stays separate from the draft');
    stage = 'finishing';
    await stop(attempt);
    const finishing = baseline ? shell.locator('.agent-chat__dictation-status[data-transcribing]') : status;
    if (!baseline) await statusIs('Finishing text. The microphone is off.');
    await finishing.waitFor();
    check(!m.close && !attempt.closed && !attempt.released && !await preview.count(),
      'Not in a held finalization state');
    await snap('finishing', finishing, 'Stopped; provider completion is still held');
    check(!m.close && !attempt.closed, 'Provider timed out before the finishing frame was captured');
    attempt.release();
    stage = 'provider-complete';
    await until(() => m.close?.completed && transcript(m) === speech.final,
      12_000, 'Fixture final and completed Gateway close were not both observed');
    const inserted = initialDraft + ' ' + speech.final;
    if (baseline) await draftIs(inserted);
    else {
      await statusIs('Text is ready to review. Nothing has been sent.');
      check(await preview.inputValue() === speech.final, 'Review did not contain the fixture final');
      await draftIs(initialDraft);
    }
    noSends();
    await snap('provider-complete', baseline ? draft : preview,
      baseline ? 'Final text is already in the draft' : 'Final text waits for explicit insertion');
    if (!baseline) {
      stage = 'inspect';
      await review.getByText('Inspect changes', { exact: true }).click();
      const original = review.getByRole('textbox', { name: 'Original finalized transcript' });
      check(await original.inputValue() === speech.final, 'Inspection did not show the fixture final');
      await snap('inspect', original, 'Original finalized transcript');
      stage = 'insert';
      await visibleButton(review, 'Use reviewed text').click();
      await draftIs(inserted);
      await preview.waitFor({ state: 'detached' });
      noSends();
      await snap('inserted', draft, 'Explicit insertion, without sending');

      stage = 'cancel';
      await draft.fill(initialDraft);
      const cancel = await start();
      await stop(cancel);
      const discards = m.discards;
      await visibleButton(review, 'Cancel text refinement').click();
      await statusIs('Text refinement cancelled. Your draft is preserved.');
      await until(() => cancel.closed && m.close && m.discards > discards, 6_000, 'Missing cancellation receipt');
      await draftIs(initialDraft);
      check(!await preview.count(), 'Cancelled review resurfaced');
      await snap('cancelled', status, 'Cancellation preserves the draft');

      stage = 'incomplete';
      const incomplete = await start();
      await stop(incomplete);
      // Deliberately never release any final for this attempt.
      const recovery = review.getByRole('textbox', { name: 'Incomplete caption — manual recovery only' });
      await recovery.waitFor({ timeout: 13_000 });
      check(await recovery.inputValue() === speech.partial && !await preview.count() &&
        !await visibleButton(review, 'Keep raw transcript').count() &&
        !await visibleButton(review, 'Use reviewed text').count(), 'Incomplete text became insertable');
      await draftIs(initialDraft);
      await snap('incomplete', recovery, 'Provisional text is manual recovery only');
    }
    noSends();
    report.result = 'PASS';
  } catch (error) {
    const ui = await page?.evaluate(() => window.readProofNotices?.()).catch(() => null);
    const notice = ui && blockingNotice(ui, Date.now() - 8000);
    report.failure = { stage, message: redact(notice?.text ??
      String(error?.message ?? error).split(/\r?\n/u, 1)[0]).slice(0, 400) };
    if (page) await snap('error', null).catch(() => {});
  } finally {
    const redactNotice = (n) => ({ ...n, text: redact(n.text) });
    const ui = await page?.evaluate(() => window.readProofNotices?.()).catch(() => null);
    report.visibleNotices = ui?.current.map(redactNotice) ?? [];
    report.noticeHistory = ui?.seen.map(redactNotice) ?? [];
    try {
      const annotationPage = frames.some(({ outline }) => outline) ? await browser.newPage({
        viewport, deviceScaleFactor: 1 }) : null;
      for (const { name, png, outline } of frames) {
        const clean = name + '-clean.png';
        await writeFile(path.join(out, clean), png);
        report.screenshots.push(clean);
        if (!outline) continue;
        const { x, y, width, height } = outline;
        const annotated = name + '-annotated.png';
        // Compose over the captured PNG, never over a second live UI frame.
        await annotationPage.setContent('<style>body{margin:0}img,svg{position:absolute;inset:0}</style>' +
          '<img src="data:image/png;base64,' + png.toString('base64') + '">' +
          '<svg width="' + viewport.width + '" height="' + viewport.height + '"><rect' +
          ' x="' + x + '" y="' + y + '" width="' + width + '" height="' + height +
          '" rx="3" fill="none" stroke="#78d9c5" stroke-width="2"/></svg>');
        await annotationPage.locator('img').evaluate((img) => img.decode());
        await annotationPage.screenshot({ path: path.join(out, annotated), scale: 'css' });
        await writeFile(path.join(out, name + '-annotations.json'),
          JSON.stringify({ viewport, scale: 1, outline }, null, 2) + '\n');
        report.screenshots.push(annotated);
      }
    } catch {
      report.result = 'ERROR_ARTIFACT';
      report.failure ??= { stage: 'artifacts', message: 'Could not write clean and annotated frames' };
    } finally {
      try {
        await browser?.close();
      } finally {
        try {
          if (gateway?.pid) {
            const signal = (name) => {
              try { process.kill(-gateway.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
            };
            signal('SIGTERM');
            await Promise.race([exited, sleep(5000, null, { ref: false })]);
            signal('SIGKILL');
            await exited;
          }
        } finally {
          try { await speech?.close(); }
          finally {
            report.gatewayEvents = m.events.map((event) => ({ ...event, type: redact(event.type) }));
            report.chatSendAttempts = m.blocked.filter((method) => method === 'chat.send').length;
            report.blockedRequests = m.blocked;
            if (m.blocked.length) {
              report.result = 'FAIL';
              report.failure = { stage: m.blockedAt, message: 'Unexpected outbound send or agent request' };
            }
            await writeFile(path.join(out, 'state.json'), JSON.stringify(report, null, 2) + '\n');
            await rm(dir, { recursive: true, force: true });
          }
        }
      }
    }
  }
  return report.result;
}

function plan(scenario) {
  const kebab = (id) => typeof id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id);
  const takes = scenario.takes?.length ? scenario.takes : [null];
  check(scenario.tts?.model && scenario.tts.voice && scenario.cases?.length &&
    Number.isFinite(scenario.leadingSilenceMs) && scenario.leadingSilenceMs >= 0 &&
    scenario.cases.every((c) => kebab(c.id) && c.initialDraft && c.expectedText &&
      ['file', 'realtime'].includes(c.route) && ['use-reviewed', 'keep-raw', 'cancel-finishing'].includes(c.action) &&
      (c.action !== 'cancel-finishing' || c.route === 'realtime')) &&
    takes.every((t) => t === null || kebab(t.id)), 'Invalid scenario or take');
  const runs = scenario.cases.flatMap((c) => takes.map((take) => ({
    c, take, id: c.id + (take ? '--' + take.id : '')
  })));
  check(new Set(runs.map((x) => x.id)).size === runs.length, 'Duplicate case or take IDs');
  return runs;
}

async function pinnedBuild(location, expected, label) {
  check(typeof location === 'string' && location, 'Missing ' + label + ' checkout');
  const checkout = await realpath(location);
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
  check(git('rev-parse', 'HEAD') === expected && !git('status', '--porcelain', '-uno'),
    label + ' checkout must be clean at ' + expected);
  const build = JSON.parse(await readFile(path.join(checkout, 'dist/build-info.json'), 'utf8'));
  check(build.commit === expected, label + ' build metadata does not match its checkout');
  await access(path.join(checkout, 'dist/control-ui/index.html'));
  return { checkout, build };
}

async function compare() {
  check(!apiKey, 'Run --compare in the offline lane, without OPENAI_API_KEY');
  check(process.env.PROOF_RESULTS_DIR, 'Missing PROOF_RESULTS_DIR');
  const beforePath = JSON.parse(process.env.PROOF_CHECKOUTS ?? '{}').before;
  const before = await pinnedBuild(beforePath, expectedBefore, 'Before');
  const after = await pinnedBuild(process.argv[2], expectedHead, 'After');
  const { chromium } = createRequire(path.join(after.checkout, 'ui/package.json'))('playwright');
  const results = path.join(path.resolve(process.env.PROOF_RESULTS_DIR), 'comparison');
  await mkdir(results, { recursive: true, mode: 0o700 });
  const run = await mkdtemp(path.join(results, 'run-'));
  const ram = await mkdtemp('/dev/shm/dictation-compare-');
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = ram;
  const cases = [];
  try {
    for (const [layout, width] of [['desktop', 1440], ['mobile', 400]]) {
      for (const [side, target] of [['before', before], ['after', after]]) {
        const out = path.join(run, layout, side);
        await mkdir(out, { recursive: true });
        const result = await runComparison({ side, viewport: { width, height: 1000 },
          ...target, chromium, out, ram });
        cases.push({ layout, side, commit: target.build.commit, result });
        console.log('comparison ' + layout + '/' + side + ': ' + result);
        if (result !== 'PASS') process.exitCode = 1;
      }
    }
  } finally {
    await rm(ram, { recursive: true, force: true });
    await writeFile(path.join(run, 'manifest.json'), JSON.stringify({ cases }, null, 2) + '\n');
  }
}

async function main() {
  const comparison = process.argv.length === 4 && process.argv[3] === '--compare';
  check(comparison || (apiKey && process.argv.length === 3),
    'Need OPENAI_API_KEY and one built checkout argument, or a built checkout and --compare');
  check(process.platform === 'linux' && (await statfs('/dev/shm')).type === 0x01021994,
    'Run on a Linux CI VM with tmpfs at /dev/shm');
  if (comparison) return compare();
  check((await readFile('/proc/swaps', 'utf8')).trim().split('\n').length === 1, 'Turn swap off before running the proof');
  const { checkout, build } = await pinnedBuild(process.argv[2], expectedHead, 'PR');
  const scenario = JSON.parse(await readFile(path.join(here, 'scenario.json'), 'utf8'));
  const { chromium } = createRequire(path.join(checkout, 'ui/package.json'))('playwright');
  // Keep the Playwright profile and the Gateway's config/state/logs in RAM, not results/.
  const ram = await mkdtemp('/dev/shm/dictation-proof-');
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = ram;
  const results = path.resolve(process.env.PROOF_RESULTS_DIR || path.join(here, 'results'));
  try {
    await mkdir(results, { recursive: true, mode: 0o700 });
    const run = await mkdtemp(path.join(results, 'run-'));
    for (const { c, take, id } of plan(scenario)) {
      const out = path.join(run, id);
      await mkdir(out);
      const clip = path.join(here, 'clips', id + '.wav');
      const result = await runCase({ c, take, clip, out, ram, checkout, chromium, build, scenario });
      console.log(id + ': ' + result);
      if (result !== 'PASS') process.exitCode = 1;
    }
    console.log('Evidence: ' + path.relative(here, run));
  } finally { await rm(ram, { recursive: true, force: true }); }
}

main().catch((error) => {
  console.error(error instanceof ProofCheck ? error.message :
    'Proof setup or cleanup failed. Check the pinned builds, Playwright, and Linux tmpfs (and the key/clips for live mode).');
  process.exitCode = 2;
});
