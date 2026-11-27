import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const expectedHead = '194fcb3f317e5d256d1c35e9a9a69a230c81a45e';
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
  return ui.current.find((n) => n.kind === 'error') ??
    ui.seen.findLast((n) => n.kind === 'error' && n.lastSeen >= since) ??
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
      const item = { kind, text, firstSeen: seen.get(key)?.firstSeen ?? lastSeen, lastSeen };
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
        m.openaiRelay = Boolean(sessionId && p.provider === 'openai' &&
          p.transport === 'gateway-relay' && p.mode === 'transcription' && p.brain === 'none');
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
    const context = await browser.newContext({ locale: 'en-US', permissions: ['microphone'],
      viewport: { width: 1280, height: 1000 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    page = await context.newPage();
    page.setDefaultTimeout(8_000);
    await observe(page, origin, m, () => report.stage);
    await page.addInitScript(installPageProbes);
    await page.goto(url.href);
    await page.waitForFunction(() => window.openclawControlUi?.snapshot().gatewayPhase === 'connected',
      undefined, { timeout: 30_000 });
    shell = page.locator('.agent-chat__composer-shell');
    draft = shell.locator('textarea[aria-label="Chat composer"]');
    const mic = shell.locator('.chat-mobile-dictation-action');
    const review = shell.locator('.agent-chat__dictation-refinement');
    const button = (scope, name) => scope.getByRole('button', { name, exact: true });
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
    await button(mic, 'Dictation text options').click();
    const optIn = review.getByRole('checkbox', { name: 'Review dictated text before inserting' });
    check(!await optIn.isChecked(), 'Review was not off by default');
    await optIn.check();
    await draft.press('End');

    step('capture');
    await button(mic, 'Dictation').click();
    await until(async () => m.providerError || m.createRejected || await shell
      .locator('.agent-chat__dictation-status [data-status="listening"]').isVisible(),
      8_000, 'Dictation did not enter listening');
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
    const stop = button(shell, 'Finish and review text');
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
    const alert = await findError(m.providerError || m.createRejected ? 750 : 0);
    if (alert) await markUiError(alert);
    else if (report.stage === 'capture' && m.providerError &&
        await draft.inputValue({ timeout: 1000 }).catch(() => null) === c.initialDraft) {
      inconclusive('TranscriptionUnavailable', 'OpenAI relay reported an error during capture');
    } else {
      // Do not persist stacks, provider payloads or Playwright call logs.
      report.failure = { step: report.stage, name: redact(error?.name ?? 'Error'),
        message: redact(String(error?.message ?? error).split(/\r?\n/u, 1)[0]).slice(0, 400) };
    }
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

async function main() {
  check(apiKey && process.argv.length === 3, 'Need OPENAI_API_KEY and one built checkout argument');
  check(process.platform === 'linux' && (await statfs('/dev/shm')).type === 0x01021994,
    'Run on a Linux CI VM with tmpfs at /dev/shm');
  check((await readFile('/proc/swaps', 'utf8')).trim().split('\n').length === 1, 'Turn swap off before running the proof');
  const checkout = await realpath(process.argv[2]);
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
  check(git('rev-parse', 'HEAD') === expectedHead && !git('status', '--porcelain', '-uno'),
    'Checkout must be clean at the pinned PR head');
  const build = JSON.parse(await readFile(path.join(checkout, 'dist/build-info.json'), 'utf8'));
  check(build.commit === expectedHead, 'Build metadata does not match the pinned head');
  await access(path.join(checkout, 'dist/control-ui/index.html'));
  const scenario = JSON.parse(await readFile(path.join(here, 'scenario.json'), 'utf8'));
  const { chromium } = createRequire(path.join(checkout, 'ui/package.json'))('playwright');
  // Keep the Playwright profile and the Gateway's config/state/logs in RAM, not results/.
  const ram = await mkdtemp('/dev/shm/dictation-proof-');
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = ram;
  const results = path.join(here, 'results');
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
    'Proof setup or cleanup failed. Check the key, pinned build, clips, Playwright, and Linux tmpfs.');
  process.exitCode = 2;
});
