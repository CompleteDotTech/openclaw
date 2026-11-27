import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const head = '878550be341eebac52bebec21bf76d83d118d915';
// These are formatting cues only. Never pass the fixture text, labels, or expected edit to STT.
const sttHints = {
  'gpt-4o-mini-transcribe': 'Write only the English words you hear, in order, separated by spaces. Use plain text without punctuation or markup. Do not combine words or act on them.',
  'whisper-1': 'we walked along the river in the afternoon and watched the birds over the water',
};
const sttModels = Object.keys(sttHints);
const chatModel = 'openai/gpt-5.4-mini';
const profileId = 'en-us-plain-code';
const draft = 'Example: ';
const actions = new Set(['insert-undo', 'copy-cancel', 'blocked-cancel']);
const denied = new Set(['chat.send', 'sessions.send', 'sessions.steer', 'agent', 'agent.run']);
const rpcs = new Set(['talk.catalog', 'talk.session.create', 'talk.session.appendAudio', 'talk.session.close']);
const errors = '[role="alert"], .agent-chat__composer-alert, .app-toast--error[data-active="true"]';
const notices = errors + ', [role="status"], .agent-chat__composer-status-text';
class UiAlertError extends Error { name = 'UiAlertError'; }
const id = s => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(s);
function check(ok, message) { if (!ok) throw new Error(message); }
async function until(test, ms, message) {
  const end = Date.now() + ms;
  do { if (await test()) return; await delay(100); } while (Date.now() < end);
  throw new Error(message);
}
function scrub(text, key) {
  return String(text).replaceAll(key, '[redacted]')
    .replace(/\bsk-[\w-]+/gu, '[redacted]')
    .replace(/\bBearer\s+[^\s"',;]+/giu, 'Bearer [redacted]')
    .replace(/\b((?:device|access|refresh|gateway)?token|api[_-]?key|authorization|password)["']?\s*[:=]\s*["']?[^\s"',;&]+/giu, '$1=[redacted]');
}
async function wavMs(file, scenario, fixture) {
  const b = await fs.readFile(file);
  check(b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE', 'Expected RIFF/WAVE');
  let fmt, pcm;
  for (let i = 12; i + 8 <= b.length;) {
    const size = b.readUInt32LE(i + 4), end = i + 8 + size;
    check(end <= b.length, 'Truncated WAV');
    const tag = b.toString('ascii', i, i + 4);
    if (tag === 'fmt ') fmt = b.subarray(i + 8, end);
    if (tag === 'data') pcm = b.subarray(i + 8, end);
    i = end + (size % 2);
  }
  check(fmt?.length >= 16 && fmt.readUInt16LE(0) === 1 && fmt.readUInt16LE(2) === 1 &&
    fmt.readUInt32LE(4) === 48000 && fmt.readUInt16LE(14) === 16 && pcm?.length % 2 === 0,
    'Expected 48 kHz mono PCM16');
  const lead = scenario.leadingSilenceMs, tail = fixture.segments.at(-1).pauseAfterMs;
  const ms = pcm.length / 96;
  check(ms > lead + fixture.segments.reduce((n, s) => n + s.pauseAfterMs, 0) && ms <= 30000 &&
    pcm.subarray(lead * 96, pcm.length - tail * 96).some(b => b !== 0), 'Invalid or silent WAV');
  return ms;
}
async function loopbackPort() {
  const server = createServer();
  await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  await new Promise((ok, fail) => server.close(e => e ? fail(e) : ok()));
  return port;
}
function frame(data) {
  try { return JSON.parse(String(data)) ?? {}; } catch { return {}; }
}
async function observe(page, origin, redact) {
  const log = { blocked: [], errors: [], finals: [], events: [], rpcResults: [], bytes: 0, creates: 0, stopped: false };
  await page.routeWebSocket(u => u.host === new URL(origin).host, client => {
    const gateway = client.connectToServer();
    const pending = new Map();
    client.onMessage(message => {
      const f = frame(message);
      if (denied.has(f.method)) {
        log.blocked.push(f.method);
        client.send(JSON.stringify({ type: 'res', id: f.id, ok: false,
          error: { code: 'UNAVAILABLE', message: 'Send blocked by dictation proof' } }));
        return;
      }
      if (rpcs.has(f.method)) pending.set(f.id, f.method);
      if (f.method === 'talk.session.create') log.creates++;
      if (f.method === 'talk.session.appendAudio' && typeof f.params?.audioBase64 === 'string') {
        log.bytes += Buffer.byteLength(f.params.audioBase64, 'base64');
      }
      gateway.send(message);
    });
    gateway.onMessage(message => {
      const f = frame(message), method = pending.get(f.id);
      if (f.type === 'res' && method) {
        pending.delete(f.id);
        if (method !== 'talk.session.appendAudio' || f.ok !== true) {
          log.rpcResults.push({ method, ok: f.ok === true, phase: log.stopped ? 'after-stop' : 'before-stop' });
        }
        if (f.ok !== true) log.errors.push(redact(method + ': ' + (f.error?.message ?? 'RPC failed')));
        else if (method === 'talk.catalog') log.catalog = f.payload?.transcription;
        else if (method === 'talk.session.create') {
          log.session = f.payload?.transcriptionSessionId;
          log.provider = f.payload?.provider;
        } else if (method === 'talk.session.close') log.closeAck = true;
      }
      const p = f.payload;
      if (f.event === 'talk.event' && typeof p?.transcriptionSessionId === 'string') {
        log.events.push({ session: p.transcriptionSessionId, type: p.type,
          talkType: p.talkEvent?.type ?? null, final: p.final ?? p.talkEvent?.final ?? null,
          seq: p.talkEvent?.seq ?? null, gatewaySeq: f.seq ?? null,
          textLength: typeof p.text === 'string' ? p.text.length : null,
          phase: log.stopped ? 'after-stop' : 'before-stop',
          ...(p.type === 'close' ? { reason: p.reason } : {}),
        });
      }
      if (f.event === 'talk.event' && log.session && p?.transcriptionSessionId === log.session) {
        if (p.type === 'close') log.closed = p.reason;
        if (p.type === 'error') log.errors.push(redact(p.message ?? 'Transcription error'));
        if (p.type === 'transcript' && p.final === true && p.talkEvent?.type === 'transcript.done' &&
            typeof p.text === 'string') log.finals.push(p.text);
      }
      client.send(message);
    });
  });
  return log;
}

function wordSpans(text, splitCase = false) {
  // The word alphabet excludes underscores, so snake_case has two words
  // for scoring. Offsets still refer to the original transcript.
  return Array.from(text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)).flatMap(m => {
    const parts = splitCase ? m[0].split(/(?<=\p{Ll})(?=\p{Lu})/u) : [m[0]];
    let end = m.index;
    return parts.map(part => {
      const start = end;
      end += part.length;
      return { word: part.toLowerCase(), start, end };
    });
  });
}

// Independent oracle: docs/experiments/developer-dictation.md, "Versioned grammar".
// Score word fidelity separately from documented syntax in the raw transcript.
function qualify(raw, fixture) {
  const { command, opener, replaceWith, lineFeedBetween, action } = fixture.expected;
  const intended = wordSpans(fixture.segments.map(s => s.text).join(' '));
  if (action === 'copy-cancel') {
    check(Array.isArray(lineFeedBetween) && lineFeedBetween.length === 2 &&
      lineFeedBetween.every(s => typeof s === 'string' && /^[a-z]+(?: [a-z]+)*$/u.test(s)),
    'Expected two plain word groups around the line feed');
  }
  const scope = wordSpans(action === 'copy-cancel'
    ? ['start code', lineFeedBetween[0], 'new line', lineFeedBetween[1], 'end code'].join(' ')
    : command ?? opener);
  const sameAt = (tokens, start, reference) =>
    reference.every((token, i) => tokens[start + i]?.word === token.word);
  const offset = intended.findIndex((_, i) => sameAt(intended, i, scope));
  check(scope.length && offset >= 0, 'Fixture scope does not match its authored utterance');

  const matchesUtterance = heard => heard.length === intended.length && sameAt(heard, 0, intended);
  const heard = wordSpans(raw);
  if (!matchesUtterance(heard)) {
    // Report observed casing joins such as PascalCase/SilverMaple without
    // repairing the transcript, guessing at lowercase joins, or permitting a UI pass.
    const wordMatch = matchesUtterance(wordSpans(raw, true));
    return { wordMatch, reason: wordMatch
      ? 'Words match after splitting case-joined text; not a documented raw command fixture'
      : 'Recognized words differ from the fixture' };
  }
  const matched = heard.slice(offset, offset + scope.length);
  const start = matched[0].start, end = matched.at(-1).end;
  const cleanScope = (start === 0 || /\s/u.test(raw[start - 1])) &&
    (end === raw.length || /\s/u.test(raw[end])) &&
    matched.slice(1).every((token, i) => /^\s+$/u.test(raw.slice(matched[i].end, token.start))) &&
    // Fixtures use plain prose only. Do not guess whether a quote or slash opened an opaque span.
    !/["'\x60“”‘’/]/u.test(raw.slice(0, start));
  if (!cleanScope) {
    return { wordMatch: true, reason: 'Words match, but the raw command scope has unsupported boundaries' };
  }
  if (action === 'blocked-cancel') return { wordMatch: true, blocked: true };
  let replacement = replaceWith;
  if (action === 'copy-cancel') {
    // Remove only the two outer labels and replace the spoken whitespace command.
    // Casing and interior whitespace of the adjacent plain word groups come from raw.
    const left = matched.slice(2, 2 + wordSpans(lineFeedBetween[0]).length);
    const right = matched.slice(4 + left.length, -2);
    replacement = raw.slice(left[0].start, left.at(-1).end) + '\x0a' +
      raw.slice(right[0].start, right.at(-1).end);
  }
  return { wordMatch: true, preview: raw.slice(0, start) + replacement + raw.slice(end) };
}

const value = l => l.evaluate(e => e.value ?? e.textContent, undefined, { timeout: 2500 });

async function readNotices(page) {
  return page.locator(':is(' + notices + '):visible').evaluateAll((nodes, errorSelector) => nodes
    .filter(e => !e.closest('[aria-busy="true"]') && getComputedStyle(e).visibility === 'visible')
    .map(e => ({
      text: e.innerText?.trim() ?? '',
      error: e.matches(errorSelector) || /^Copy failed\./u.test(e.innerText?.trim() ?? ''),
      review: Boolean(e.closest('.developer-syntax__review')),
    })).filter(e => e.text), errors);
}

function catalogPinsModel(catalog, model) {
  if (catalog?.ready !== true || catalog.source !== 'media-understanding' ||
      catalog.activeProvider !== 'openai' || catalog.providers?.length !== 1) return false;
  const [provider] = catalog.providers;
  return provider.id === 'openai' && provider.configured === true &&
    provider.models?.length === 1 && provider.models[0] === model;
}

async function runTake({ chromium, env, origin, fixture, take, clip, scenario, out, redact, stt }) {
  const state = { case: fixture.id, take: take ?? null, head, requestedModel: stt, model: null,
    transcriptionHint: sttHints[stt], transcriptionLanguage: 'en', status: 'FAIL', step: 'validate WAV' };
  let browser, page, input, review, log;
  const raw = () => log?.finals.join('\x0a') ?? '';
  const seen = new Map();
  let ignore = () => false;
  const sampleNotices = async () => {
    const list = page ? await readNotices(page).catch(() => []) : [];
    return list.map(n => {
      const entry = { ...n, text: redact(n.text), step: state.step };
      seen.set(JSON.stringify(entry), entry);
      return entry;
    });
  };
  const visibleAlerts = list => [...new Set(list.filter(n => n.error && !ignore(n)).map(n => n.text))];
  const waitUi = async (test, ms, label, allow = () => false, defer = false) => {
    ignore = allow;
    const end = Date.now() + ms;
    do {
      const ready = await test();
      const alerts = visibleAlerts(await sampleNotices());
      if (ready) return;
      if (alerts.length && (!defer || Date.now() >= end)) throw new UiAlertError(alerts.join('\x0a'));
      if (Date.now() >= end) throw new Error(label);
      await delay(100);
    } while (true);
  };
  const requireVisible = (l, label, allow) => waitUi(() => l.isVisible(), 15000, label, allow);
  const requireEnabled = (l, label, allow) => waitUi(async () =>
    await l.isVisible() && await l.isEnabled(), 15000, label, allow);
  const inReview = n => n.review;
  const incomplete = n => n.review && n.text.startsWith('The spoken command is incomplete.');
  const screenshot = async (name, target) => {
    if (!page || !await page.locator('body').isVisible()) return;
    await sampleNotices();
    if (target && await target.isVisible()) await target.scrollIntoViewIfNeeded({ timeout: 2500 });
    const text = await page.locator('body').evaluate(e => [e.innerText,
      ...Array.from(e.querySelectorAll('input, textarea'), n => n.value)].join('\x0a'));
    if (redact(text) !== text) {
      state.screenshotOmitted = 'Possible secret in rendered content; no screenshot written';
      return;
    }
    await page.screenshot({ path: join(out, name), fullPage: true, animations: 'disabled', timeout: 5000 });
    state.screenshot = name;
  };
  const health = () => {
    check(!log.blocked.length, 'Unexpected send blocked: ' + log.blocked.join(', '));
    check(!log.errors.length, log.errors[0]);
  };
  try {
    const ms = await wavMs(clip, scenario, fixture);
    state.step = 'launch Chromium and load Control UI';
    browser = await chromium.launch({ env, args: [
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      '--use-file-for-fake-audio-capture=' + clip + '%noloop',
    ] });
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
    await context.grantPermissions(['microphone', 'clipboard-read', 'clipboard-write'], { origin });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    log = await observe(page, origin, redact);
    await page.goto(origin + '/chat', { waitUntil: 'domcontentloaded' });
    const button = (name, scope = page) => scope.getByRole('button', { name, exact: true });
    const composer = page.locator('.agent-chat__composer-shell');
    input = composer.locator('textarea[aria-label="Chat composer"]');
    const shell = composer.locator('.developer-syntax');
    review = shell.getByRole('region', { name: 'Review dictated syntax' });
    const start = button('Start voice input', composer), stop = button('Stop and keep text', composer);
    state.step = 'wait for enabled composer and OpenAI file transcription';
    await waitUi(async () => {
      health();
      return await input.isVisible() && await input.isEnabled() && await input.isEditable() &&
        !await page.getByText('Set up a model', { exact: true }).first().isVisible() &&
        catalogPinsModel(log.catalog, stt);
    }, 30000, 'Composer or OpenAI file transcription (' + stt + ') was not ready', undefined, true);

    state.step = 'enable Developer mode and seed draft';
    const disclosure = shell.locator('summary');
    const enabled = shell.getByLabel('Enable exact syntax review');
    await requireVisible(disclosure, 'Dictation syntax settings missing');
    await disclosure.click();
    await requireEnabled(enabled, 'Exact syntax review setting unavailable');
    await enabled.check();
    await shell.getByLabel('Dictation mode').selectOption('developer');
    await shell.getByLabel('Spoken command language').selectOption('en-US');
    await shell.getByLabel('Syntax profile').selectOption(profileId);
    await shell.locator('summary').click();
    await input.click();
    await page.keyboard.type(draft);
    await input.press('End');
    check(await value(input) === draft, 'Could not seed draft');

    state.step = 'capture WAV and wait for final transcription';
    await requireEnabled(start, 'Microphone button unavailable');
    const box = await start.boundingBox();
    check(box, 'Microphone button unavailable');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try { await requireVisible(stop, 'Stop control did not appear'); } finally { await page.mouse.up(); }
    await requireVisible(composer.locator('.agent-chat__dictation-phase--listening'), 'Listening state did not appear');
    const stopAt = Date.now() + ms + 250;
    await waitUi(() => Date.now() >= stopAt, ms + 1250, 'Capture wait expired');
    await requireEnabled(stop, 'Stop control unavailable');
    log.stopped = true; // The phase boundary is immediately before invoking Stop.
    await stop.click();
    await waitUi(() => { health(); return log.closeAck && log.closed; }, 55000, 'Transcription did not settle', inReview);
    check(log.closed === 'completed' && log.creates === 1 && log.provider === 'openai' &&
      log.bytes >= (ms - 400) * 8 && log.finals.length === 1, 'Missing or incomplete OpenAI capture');
    // File transcription events carry text, not a model ID. The singleton
    // configuration plus the Gateway catalog and successful final establish the model.
    check(catalogPinsModel(log.catalog, stt), 'Gateway catalog did not pin the requested file model');
    state.model = stt;
    check(await value(input) === draft, 'Capture changed the draft before review');

    state.step = 'qualify transcript and verify exact review';
    const transcript = raw();
    if (transcript.trim()) {
      await requireVisible(review, 'Dictation review did not appear', inReview);
      const original = review.getByLabel('Recognized original');
      await requireVisible(original, 'Recognized original missing', inReview);
      check(await value(original) === transcript, 'Review changed recognized original');
    }
    const sample = qualify(transcript, fixture);
    state.sttWordMatch = sample.wordMatch;
    state.sttScopeMatch = !sample.reason;
    const insert = button('Insert into draft', review), copy = button('Copy exact text', review);
    const cancel = button('Cancel review', review);
    const allowed = sample.reason ? inReview : sample.blocked ? incomplete : undefined;
    if (sample.reason) {
      await screenshot('screenshot.png', transcript.trim() ? review : input);
      if (transcript.trim()) {
        await requireEnabled(cancel, 'Cancel review unavailable', allowed);
        await cancel.click();
      }
      state.status = 'INCONCLUSIVE_STT';
      state.reason = sample.reason;
    } else if (sample.blocked) {
      await requireVisible(review.getByRole('alert').getByText(/^The spoken command is incomplete\./u),
        'Expected incomplete-command alert missing', allowed);
      check(await insert.isDisabled() && await copy.isDisabled(), 'Incomplete command was actionable');
      await screenshot('screenshot.png', review);
      state.step = 'cancel blocked review';
      await requireEnabled(cancel, 'Cancel review unavailable', allowed);
      await cancel.click();
    } else {
      const previewBox = review.getByLabel('Exact preview');
      await requireVisible(previewBox, 'Exact preview missing');
      const preview = await value(previewBox);
      state.expectedPreview = redact(sample.preview);
      state.preview = redact(preview);
      check(preview === sample.preview, 'Exact preview differed from the expected edit');
      if (fixture.expected.action === 'copy-cancel') {
        await review.getByLabel('Inspect literal characters').check();
        check((await value(review.getByLabel('Character names and Unicode values'))).includes('U+000A'),
          'Character inspector did not identify LF');
      }
      await screenshot('screenshot.png', review);
      if (fixture.expected.action === 'insert-undo') {
        state.step = 'insert and undo in native textarea';
        await requireEnabled(insert, 'Insert control unavailable');
        await insert.click();
        await waitUi(async () => !await review.isVisible(), 15000, 'Review stayed open after insertion');
        check(await value(input) === draft + sample.preview, 'Insertion was not exact');
        await input.press('Control+z');
      } else {
        state.step = 'copy exact LF and cancel';
        await requireEnabled(copy, 'Copy control unavailable');
        await copy.click();
        await requireVisible(shell.getByText('Exact text copied.', { exact: true }), 'Copy confirmation missing');
        const clipboard = await page.evaluate(() => navigator.clipboard.readText());
        check(clipboard === sample.preview, 'Clipboard changed LF or surrounding text');
        state.clipboard = redact(clipboard);
        await requireEnabled(cancel, 'Cancel review unavailable');
        await cancel.click();
      }
    }
    await waitUi(async () => !await review.isVisible(), 15000, 'Review did not close', allowed);
    await waitUi(async () => { health(); return await input.isVisible() && await value(input) === draft; },
      5000, 'Undo or cancel did not restore draft');
    check(state.screenshot, 'No sanitized proof screenshot captured');
    if (state.status !== 'INCONCLUSIVE_STT') state.status = 'PASS';
  } catch (e) {
    let alerts = visibleAlerts(await sampleNotices());
    if (!alerts.length && page && log?.errors.length) {
      await until(async () => (alerts = visibleAlerts(await sampleNotices())).length, 600, '').catch(() => {});
    }
    if (!alerts.length && e?.name === 'TimeoutError') {
      alerts = visibleAlerts([...seen.values()].filter(n => n.step === state.step));
    }
    state.status = e instanceof UiAlertError || alerts.length ? 'ERROR' : 'FAIL';
    state.error = {
      name: state.status === 'ERROR' ? 'UiAlertError' : redact(e?.name ?? 'Error'),
      message: alerts.length ? alerts.join('\x0a') : redact(e?.message ?? e).slice(0, 1800),
    };
  } finally {
    await sampleNotices();
    if (state.status === 'ERROR' || state.status === 'FAIL') {
      const alert = page?.locator(':is(' + errors + '):visible').first();
      await screenshot('failure.png', alert).catch(() => {});
    }
    state.finalDraft = await (input ? value(input).then(redact).catch(() => null) : null);
    state.reviewOpen = await review?.isVisible().catch(() => false) ?? false;
    await browser?.close().catch(() => {});
    state.blockedRequests = log?.blocked ?? [];
    if (state.blockedRequests.length) {
      state.status = 'FAIL';
      state.error = { name: 'UnexpectedSend', message: 'Blocked: ' + state.blockedRequests.join(', ') };
    }
    state.visibleNotices = [...seen.values()];
    state.gatewayEvents = (log?.events ?? []).filter(e => e.session === log.session)
      .map(({ session, ...event }) => event);
    state.gatewayRpcResults = log?.rpcResults ?? [];
    state.audioBytesSent = log?.bytes ?? 0;
    state.gatewayCompleted = log?.closed === 'completed' && log?.closeAck === true;
    state.provider = log?.provider === 'openai' ? 'openai' : null;
    const transcript = redact(raw());
    console.log(JSON.stringify({ case: state.case, take: state.take, status: state.status,
      requestedModel: state.requestedModel, model: state.model, transcript,
      reason: state.error?.message ?? state.reason ?? null }));
    await fs.writeFile(join(out, 'transcript.txt'), transcript, { mode: 0o600 });
    await fs.writeFile(join(out, 'state.json'), JSON.stringify(state, null, 2) + '\x0a', { mode: 0o600 });
  }
  return state.status;
}

async function withGateway({ checkout, ui, key, stt }, use) {
  const tmp = await fs.mkdtemp('/dev/shm/openclaw-dictation-');
  const previousTmp = process.env.TMPDIR;
  let gateway, exited;
  try {
    process.env.TMPDIR = tmp;
    const env = { HOME: tmp, TMPDIR: tmp, PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8',
      XDG_CONFIG_HOME: join(tmp, 'config'), XDG_CACHE_HOME: join(tmp, 'cache') };
    const config = join(tmp, 'openclaw.json'), port = await loopbackPort();
    const origin = 'http://127.0.0.1:' + port;
    await fs.writeFile(config, JSON.stringify({
      gateway: { mode: 'local', bind: 'loopback', auth: { mode: 'none' }, controlUi: { enabled: true, root: ui } },
      logging: { file: join(tmp, 'gateway.log') },
      plugins: { allow: ['openai'], entries: { openai: { enabled: true } } },
      agents: { defaults: { workspace: join(tmp, 'workspace'), model: { primary: chatModel }, models: { [chatModel]: {} } } },
      tools: { media: { audio: { enabled: true }, models: [
        { type: 'provider', provider: 'openai', model: stt, capabilities: ['audio'],
          language: 'en', prompt: sttHints[stt], timeoutSeconds: 30 },
      ] } },
      talk: { realtime: { mode: 'stt-tts' } },
    }), { mode: 0o600 });
    gateway = spawn(process.execPath, [join(checkout, 'openclaw.mjs'), 'gateway', 'run', '--bind', 'loopback', '--port', String(port)], {
      cwd: tmp, stdio: 'ignore', env: { ...env, OPENAI_API_KEY: key, OPENCLAW_HOME: tmp,
        OPENCLAW_CONFIG_PATH: config, OPENCLAW_STATE_DIR: join(tmp, 'state'),
        OPENCLAW_DISABLE_BONJOUR: '1', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_SKIP_CRON: '1' },
    });
    let dead = false;
    exited = new Promise(done => {
      const finish = () => { dead = true; done(); };
      gateway.once('error', finish);
      gateway.once('close', finish);
    });
    await until(async () => {
      check(!dead, stt + ': Gateway exited during startup');
      const r = await fetch(origin + '/readyz', { signal: AbortSignal.timeout(1000) }).catch(() => null);
      await r?.body?.cancel();
      return r?.ok;
    }, 90000, stt + ': Gateway readiness timed out');
    await use({ env, origin });
  } finally {
    if (gateway) {
      gateway.kill('SIGTERM');
      await Promise.race([exited, delay(8000, undefined, { ref: false })]);
      if (gateway.exitCode === null && gateway.signalCode === null) gateway.kill('SIGKILL');
      await exited;
    }
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function main(key) {
  check(process.argv.length === 3 && key, 'Usage: OPENAI_API_KEY in env; node proof.mjs <built PR checkout>');
  delete process.env.OPENAI_API_KEY;
  const redact = s => scrub(s, key);
  const checkout = resolve(process.argv[2]);
  check(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() === head,
    'Build and pass the pinned PR checkout, not the proof branch');
  const ui = join(checkout, 'dist/control-ui');
  await fs.access(join(ui, 'index.html'));
  const { chromium } = createRequire(join(checkout, 'ui/package.json'))('playwright');
  const scenario = JSON.parse(await fs.readFile(join(here, 'scenario.json'), 'utf8'));
  const takes = scenario.takes?.length ? scenario.takes.map(t => t.id) : [null];
  check(takes.every(t => t === null || id(t)) && new Set(takes).size === takes.length, 'Invalid take IDs');
  const cases = scenario.cases;
  check(cases.length && cases.every(c => id(c.id) && actions.has(c.expected?.action) &&
    sttModels.includes(c.transcriptionModel)) &&
    new Set(cases.map(c => c.id)).size === cases.length, 'Invalid case IDs, actions, or transcription models');
  for (const c of cases) {
    check(!qualify(c.segments.map(s => s.text).join(' '), c).reason, 'Invalid canonical fixture: ' + c.id);
  }
  check((await fs.statfs('/dev/shm')).type === 0x01021994, 'Linux /dev/shm tmpfs is required');
  const results = join(here, 'results');
  await fs.mkdir(results, { recursive: true });
  const run = await fs.mkdtemp(join(results, head.slice(0, 8) + '-'));
  const summary = {};
  for (const stt of sttModels) {
    const group = cases.filter(c => c.transcriptionModel === stt);
    if (!group.length) continue;
    await withGateway({ checkout, ui, key, stt }, async ({ env, origin }) => {
      for (const fixture of group) {
        const statuses = {};
        for (const take of takes) {
          const stem = fixture.id + (take ? '--' + take : '');
          const out = join(run, stem);
          await fs.mkdir(out, { mode: 0o700 });
          statuses[take ?? 'default'] = await runTake({ chromium, env, origin, fixture, take, scenario, out, redact, stt,
            clip: join(here, 'clips', stem + '.wav') });
        }
        const all = Object.values(statuses);
        summary[fixture.id] = {
          requestedModel: stt,
          takes: statuses,
          status: all.includes('ERROR') ? 'ERROR' : all.includes('FAIL') ? 'FAIL'
            : all.includes('PASS') ? 'PASS' : 'INCONCLUSIVE_STT',
        };
      }
    });
  }
  await fs.writeFile(join(run, 'summary.json'), JSON.stringify({ head, cases: summary }, null, 2) + '\x0a', { mode: 0o600 });
  console.log('Results: ' + run);
  const all = Object.values(summary).map(c => c.status);
  process.exitCode = all.some(s => s === 'ERROR' || s === 'FAIL') ? 1 : all.includes('INCONCLUSIVE_STT') ? 2 : 0;
}

const key = process.env.OPENAI_API_KEY?.trim();
main(key).catch(e => {
  console.error('FAIL: ' + (key ? scrub(e.message, key).slice(0, 1800) : 'OPENAI_API_KEY is missing'));
  process.exitCode = 1;
});
