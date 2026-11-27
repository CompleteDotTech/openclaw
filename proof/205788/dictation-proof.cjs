// Node 24, Linux. Run only in an isolated job on author-reviewed code.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { randomBytes, createHash } = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { fixtureWindow, watchToolFilterWarning, probeCompanion, verifyClipBindings, recognizerReceipt } = require('./proof-receipts.cjs');
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
class BlockedSubmit extends Error { name = 'BlockedSubmit'; }
const dashboardKey = /^agent:main:dashboard:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function targetKind(value, s) {
  if (value === undefined) return 'absent';
  if (s?.owner && value === s.owner) return 'seeded-owner';
  if (s?.standby?.createdKey && value === s.standby.createdKey) return 'standby';
  return typeof value === 'string' && dashboardKey.test(value) ? 'main-dashboard-uuid' : 'other';
}
// Keep the reason, not Playwright's DOM/call log, assert's value diff, or an embedded RPC dump.
function consoleText(value, limit = 440) {
  return require('node:util').stripVTControlCharacters(scrub(value)).trim().split(/[\x0d\x0a\u2028\u2029]/, 1)[0]
    .replace(/\b(?:Basic|Bearer)\s+\S+|\b(?:gh[pousr]_|github_pat_)[\w-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/gi, '[redacted]')
    .replace(/\b(?:[\w-]*(?:token|password|secret)|api[_-]?key|authorization|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '[redacted]')
    .replace(/\bagent:[^\s'"\],)]+|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '[session]')
    .replace(/\{.*|\[\s*["{].*/u, '[structured data omitted]')
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, limit);
}
function collectWireEvidence(result, s, surface) {
  result.routing = {
    standaloneTalk: s?.hasAuth ? s.hasTalk : null,
    recoveryScopePresent: s?.hasAuth ? s.hasRecoveryScope : null,
    dictationHasTarget: s?.sid ? Boolean(s.target) : null,
    captureTarget: s?.sid ? targetKind(s.target, s) : 'not-observed', expectedStandby: s?.expectStandby ?? null,
    standbyReused: Boolean(s?.standby?.accepted && s.standby.createdKey === s.target),
    ...(surface === 'side' ? { companionDefault: s?.companionDefault ?? 'not-observed' } : {}),
    expectedMethod: s?.allow?.method ?? null,
    expectedTarget: !s?.allow ? 'not-armed' : s.allow.freshCreate ? 'absent-or-fresh-main-dashboard-uuid' : targetKind(s.allow.target, s),
  };
  result.writes = (s?.writes ?? []).map(w => ({ method: w.method, target: w.targetKind,
    accepted: w.accepted ?? null, blocked: Boolean(w.blocked), ...(w.blocked ? { guardReason: w.blocked } : {}),
    nonempty: Boolean(w.text), textMatches: w.textMatches, sameDictationSession: Boolean(w.target && w.target === s.target),
    returnedKey: Boolean(w.createdKey), keyOK: w.keyOK ?? null, runStarted: w.runStarted ?? null,
    rpcOK: w.rpcOK ?? null, responseMs: w.responseMs ?? null, answerPresent: w.answerPresent ?? null,
    ...(w.fixtureStart ? { fixturePosts: w.fixturePosts ?? null, fixtureAnswer: w.fixtureAnswer ?? null,
      fixtureWindow: w.fixtureWindow ?? null } : {}),
    code: w.code ?? null, detail: w.detail ?? null, error: w.error ?? null }));
}
function takeLine(name, result) {
  if (result.status === 'PASS') {
    const ask = result.writes?.find(w => w.method === 'sessions.companion.ask');
    return name + ' PASS ' + JSON.stringify({ asr: result.recognizer,
      ...(result.pendingProbe ? { writeCount: result.writes?.length, pendingProbe: result.pendingProbe } : {}),
      ...(ask ? { method: ask.method, target: ask.target, textMatches: ask.textMatches, rpcOK: ask.rpcOK,
        fixtureAnswer: ask.fixtureAnswer, fixtureWindow: ask.fixtureWindow, render: result.render } : {}),
      ...(result.explicitASR ? { explicitASR: result.explicitASR } : {}) });
  }
  const all = result.writes;
  const sample = all.length <= 4 ? all : [...all.slice(0, 2), ...all.slice(-2)];
  return name + ' ' + result.status + ' ' + JSON.stringify({
    step: result.error.step, error: consoleText(result.error.message), routing: result.routing, asr: result.recognizer,
    writeCount: all.length, writes: sample.map(w => ({ method: w.method, target: w.target,
      textMatches: w.textMatches, blocked: w.blocked, ...(w.blocked ? { why: w.guardReason } : {}),
      rpcOK: w.rpcOK, accepted: w.accepted, responseMs: w.responseMs,
      ...(w.method === 'sessions.create' ? { keyOK: w.keyOK, runStarted: w.runStarted } : {}),
      ...(w.method === 'sessions.companion.ask' ? { answerPresent: w.answerPresent, fixturePosts: w.fixturePosts,
        fixtureAnswer: w.fixtureAnswer, fixtureWindow: w.fixtureWindow } : {}),
      ...(w.code ? { code: w.code } : {}), ...(w.detail ? { detail: w.detail } : {}),
      ...(w.error ? { error: consoleText(w.error, 180) } : {}) })),
    ...(sample.length < all.length ? { omittedWrites: all.length - sample.length } : {}),
    ...(result.render ? { render: result.render } : {}),
    ...(result.explicitASR ? { explicitASR: result.explicitASR } : {}),
    ...(result.pendingProbe ? { pendingProbe: result.pendingProbe } : {}),
    ...(result.alerts?.length ? { lastAlert: consoleText(result.alerts.at(-1).text, 180) } : {}),
  });
}
// Independent positive control for this one utterance, not the candidate parser. Retain
// lexical casing and horizontal separators. Only a matching mark immediately AFTER its
// command may already exist. Do not bless marks before commands or duplicate punctuation.
function explicitControl(raw) {
  const m = /^(call[ \t]+me)([ \t]+insert[ \t]+comma)(,?)([ \t]+please)([ \t]+insert[ \t]+period)(\.?)$/i.exec(raw);
  if (!m) return null;
  const first = m[1].length, second = first + m[2].length + m[3].length + m[4].length;
  return { text: m[1] + ',' + m[4] + '.', edits: [
    { start: first, end: first + m[2].length, text: m[3] ? '' : ',', reason: 'explicit-punctuation' },
    { start: second, end: second + m[5].length, text: m[6] ? '' : '.', reason: 'explicit-punctuation' },
  ] };
}
function checkExplicit(result, control) {
  assert.equal(result.status, 'refined', 'qualified spoken commands were not refined');
  assert.deepEqual(result.edits, control.edits, 'explicit edit source spans or replacements were wrong');
  assert.equal(result.text, control.text, 'qualified spoken commands produced the wrong punctuation or casing');
}
// For an exact word match only, show the fixed script's casing and separators. Never
// print a free-form ASR miss. JSON escapes whitespace on the single-line receipt.
function explicitObservation(raw, intended, complete, qualified) {
  const lexicalMatch = words(raw) === intended;
  const safeFixture = lexicalMatch && raw.length <= 128 && /^[a-zA-Z \t\x0a.,:;!?"'()\x60-]+$/.test(raw);
  return { complete, lexicalMatch, qualified, ...(safeFixture ? { fixtureForm: raw } : {}) };
}
// Stub only inference, never the browser or Gateway. The real ask RPC returns after the
// answer. Each issued answer is distinct; a cached answer or optimistic turn cannot pass.
const fixtureProvider = 'dictation-fixture', fixtureId = 'side-receipt';
const fixtureRef = fixtureProvider + '/' + fixtureId, fixtureKey = 'synthetic-loopback-only';
async function startCompanionFixture() {
  const issued = new Map();
  let posts = 0, otherPosts = 0, authRejects = 0, modelRejects = 0;
  const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const server = http.createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        return json(res, 200, { object: 'list', data: [{ id: fixtureId, object: 'model' }] });
      }
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        if (req.method === 'POST') otherPosts++; // Count unexpected paths, never print them.
        return res.writeHead(404).end();
      }
      posts++;
      if (req.headers.authorization !== 'Bearer ' + fixtureKey) { authRejects++; return res.writeHead(401).end(); }
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) return res.writeHead(413).end();
        chunks.push(chunk);
      }
      // No headers, prompts, model traffic or credentials are logged, persisted or echoed.
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body?.model !== fixtureId) {
        modelRejects++; return json(res, 400, { error: { message: 'wrong fixture model' } });
      }
      const id = randomBytes(12).toString('hex');
      const answer = 'Local dictation receipt ' + id + '.';
      issued.set(answer, issued.size + 1);
      const item = { type: 'message', id: 'msg_' + id, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: answer, annotations: [] }] };
      const response = { id: 'resp_' + id, object: 'response', status: 'completed', model: fixtureId,
        output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      if (body.stream === false) return json(res, 200, response);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const emit = event => res.write('data: ' + JSON.stringify(event) + '\x0a\x0a');
      const index = { item_id: item.id, output_index: 0, content_index: 0 };
      emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      emit({ type: 'response.output_text.delta', ...index, delta: answer });
      emit({ type: 'response.output_text.done', ...index, text: answer });
      emit({ type: 'response.output_item.done', output_index: 0, item });
      emit({ type: 'response.completed', response });
      res.end('data: [DONE]\x0a\x0a');
    })().catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    snapshot: () => ({ posts, otherPosts, authRejects, modelRejects, issued: issued.size }),
    isFreshAnswer: (value, since) => (issued.get(value) ?? 0) > since,
    close: () => new Promise((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve()); server.closeAllConnections();
    }) };
}

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

async function watchGateway(page, origin, surface, step, knownKeys, chatModel, fixture, warningCount = () => 0) {
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
      if (m.method === 'talk.session.appendAudio' && s.sid && p.sessionId === (s.audioRpcId ?? s.sid)) {
        s.audio++;
        if (typeof p.audioBase64 === 'string') {
          // Fingerprint bytes forwarded by the browser, not raw audio in logs or extra upload artifacts.
          const bytes = Buffer.from(p.audioBase64, 'base64');
          (s.audioHash ??= createHash('sha256')).update(bytes);
          s.audioBytes = (s.audioBytes ?? 0) + bytes.length;
        }
      }
      if (m.method === 'talk.session.create' && p.mode === 'transcription') {
        s.allowStandby = false;
        pending.set(m.id, { kind: 'capture', target: p.sessionKey });
      }
      if (m.method === 'talk.session.close' && s.sid && p.sessionId === (s.audioRpcId ?? s.sid) && !p.discard) {
        s.closeRequested = true;
        pending.set(m.id, { kind: 'close' });
      }
      if (surface === 'side' && m.method === 'sessions.companion.state' && s.owner && p.sessionKey === s.owner) {
        pending.set(m.id, { kind: 'sideState' });
      }
      if (submits.has(m.method)) {
        const create = m.method === 'sessions.create', ask = m.method === 'sessions.companion.ask';
        const w = { method: m.method, text: (ask ? p.question : p.message) ?? '',
          target: create ? p.key : p.sessionKey, at: Date.now() };
        s.writes.push(w);
        w.targetKind = targetKind(w.target, s);
        w.textMatches = s.allow ? w.text === s.allow.text : null;
        const agentOK = p.agentId === 'main' || (!create && p.agentId === undefined);
        const emptyList = a => a === undefined || (Array.isArray(a) && a.length === 0);
        const plain = emptyList(p.attachments) && emptyList(p.mentions) && !p.deliver && !p.task &&
          !p.selectionContext && (ask ? p.message === undefined : p.question === undefined) &&
          (create ? p.sessionKey === undefined && !p.fork && !p.forkFrom && !p.parentSessionKey &&
            !p.incognito && !p.catalogId : p.key === undefined);
        const standby = surface === 'new' && s.expectStandby && s.allowStandby && !s.standby &&
          create && w.target === undefined && w.text === '';
        const unusedKey = typeof w.target === 'string' && dashboardKey.test(w.target) && !knownKeys.has(w.target);
        const modelOK = !ask || (p.model === undefined || p.model === fixtureRef) && s.companionDefault === 'loopback-fixture';
        const reason = s.violation ? 'after an earlier blocked request' : !agentOK ? 'wrong agent' :
          !plain ? 'unexpected payload fields' : standby ? null : !s.allow ? 'not armed for explicit submit' :
          s.sent ? 'duplicate submit' : w.method !== s.allow.method ? 'wrong method; expected ' + s.allow.method :
          !w.textMatches ? 'wrong submitted text' : !modelOK ? 'side ask is not routed to the loopback fixture' : s.allow.freshCreate ?
            (w.target === undefined || unusedKey ? null : 'create key is not a fresh main dashboard UUID') :
            w.target === s.allow.target ? null : 'wrong session target';
        if (reason) {
          w.blocked = reason;
          s.violation ??= { method: m.method, step: step(), reason };
          socket.send(JSON.stringify({ type: 'res', id: m.id, ok: false,
            error: { code: 'UNAVAILABLE', message: 'Blocked by dictation proof send guard' } }));
          return;
        }
        if (ask) { w.fixtureStart = fixture.snapshot(); w.warningsAtStart = warningCount(); }
        if (standby) s.standby = w;
        else s.sent = w;
        if (create && w.target !== undefined) knownKeys.add(w.target);
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
          s.hasRecoveryScope = Boolean(p.auth.recoveryScope);
          // At the pinned head, operator.write and operator.admin imply operator.talk.
          s.hasTalk = p.auth.role === 'operator' &&
            ['operator.talk', 'operator.write', 'operator.admin'].some(scope => scopes.includes(scope));
        } else {
          s.hasAuth = false;
          s.hasTalk = false;
          s.hasRecoveryScope = false;
        }
      }
      if (m.type === 'res' && pending.has(m.id)) {
        const r = pending.get(m.id); pending.delete(m.id);
        if (r.kind === 'capture') {
          s.sid = p.transcriptionSessionId ?? p.sessionId; // Talk events key off the transcription id.
          s.audioRpcId = p.sessionId ?? s.sid; // appendAudio and close use the capture RPC id.
          s.target = r.target;
          s.provider = p.provider;
          if (!m.ok) s.captureRejected = scrub(m.error?.message || 'Gateway rejected capture');
        } else if (r.kind === 'close') {
          s.closed = m.ok === true;
          if (!m.ok) s.closeRejected = scrub(m.error?.message || 'Gateway rejected finalization');
        } else if (r.kind === 'sideState') {
          // Observe the UI's own hydration. Do not change the route or retain exchanges/model IDs.
          s.companionDefault = !m.ok ? 'state-rejected' : !p.defaultModel ? 'not-reported' :
            p.defaultModel === fixtureRef ? 'loopback-fixture' : p.defaultModel === chatModel ? 'same-as-primary' : 'different-from-primary';
        } else {
          const w = r.w;
          w.rpcOK = m.ok === true;
          w.responseMs = Date.now() - w.at;
          const fault = m.error ?? p.runError;
          w.code = typeof fault?.code === 'string' ? consoleText(fault.code, 64) : null;
          const detail = fault?.details?.reason ?? fault?.details?.code;
          w.detail = typeof detail === 'string' ? consoleText(detail, 80) : null;
          let problem = !w.rpcOK || fault !== undefined ?
            (typeof fault?.message === 'string' && fault.message || 'Gateway rejected the request') : null;
          if (w.method === 'sessions.create') {
            w.createdKey = p.key;
            w.runStarted = typeof p.runStarted === 'boolean' ? p.runStarted : null;
            w.keyOK = typeof p.key === 'string' && dashboardKey.test(p.key) &&
              (w.target === undefined ? !knownKeys.has(p.key) : p.key === w.target);
            if (typeof p.key === 'string') knownKeys.add(p.key);
            problem ??= p.ok !== true ? 'sessions.create returned ok != true' :
              !w.keyOK ? 'sessions.create returned a missing, reused, or different key' :
              p.runStarted !== (w !== s.standby) ? 'unexpected sessions.create runStarted' : null;
          } else if (w.method === 'sessions.companion.ask') {
            // The RPC returns the completed answer, not a chat.send-style startup ack. Never retain it.
            w.answerPresent = typeof p.answer === 'string' && Boolean(p.answer.trim());
            w.fixtureWindow = { ...fixtureWindow(w.fixtureStart, fixture.snapshot()),
              emptyToolWarningObserved: warningCount() > w.warningsAtStart };
            w.fixturePosts = w.fixtureWindow.posts;
            w.fixtureAnswer = fixture.isFreshAnswer(p.answer, w.fixtureStart.issued);
            problem ??= !w.answerPresent || !Number.isSafeInteger(p.ts) || p.ts < 0 ?
              'invalid companion answer receipt (expected nonempty answer and timestamp)' :
              !w.fixtureAnswer ? 'companion did not return an answer issued by the loopback fixture for this request window' : null;
          } else if (['error', 'timeout', 'rejected'].includes(p.status)) {
            problem ??= 'Gateway send status: ' + p.status;
          }
          w.accepted = problem === null;
          w.error = problem === null ? null : scrub(problem).slice(0, 1200);
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
  if (surface === 'new' && !s.expectStandby) return { method: 'sessions.create', text, freshCreate: true };
  return { method: surface === 'side' ? 'sessions.companion.ask' : 'chat.send', text,
    target: surface === 'new' ? s.standby.createdKey : target };
}

function renderedUserTurns(page, box, surface, text) {
  const side = surface === 'side';
  const thread = side ? box.locator('xpath=ancestor::section[contains(@class,"chat-session-rail")][1]')
    .locator('.chat-session-rail__thread') : page.locator('.chat-thread');
  const groups = thread.locator('.chat-group.user').filter({ visible: true });
  const exact = groups.getByText(text, { exact: true }).filter({ visible: true });
  return { exact, sample: async () => ({ scope: side ? 'owning-side-rail' : 'main-thread',
    visibleUserGroups: await groups.count(), exactVisibleMatches: await exact.count() }) };
}

// A disabled New Session submit can leave a real textarea Enter native. Only this
// negative control may count that physical keystroke as a user edit, never as dictation.
async function probeNewPendingEnter(field, review, raw, result, checkGuard) {
  const insert = button(review, 'Insert into draft');
  const probe = result.pendingProbe = { button: result.pendingButton };
  await sleep(400); checkGuard();
  probe.beforeUnchanged = await field.inputValue() === draft;
  assert.ok(probe.beforeUnchanged, 'pending draft changed before the Enter probe');
  assert.ok(await review.isVisible() && await insert.isEnabled() && await field.isEditable(),
    'expected an editable draft and a live uninserted review before pending Enter');
  await field.press('End'); // No selection to replace; the seed is one line.
  const readTrace = await field.evaluateHandle((el, seed) => {
    let key, before;
    const t = { beforeAtEnd: el.value === seed && el.selectionStart === seed.length && el.selectionEnd === seed.length,
      keys: 0, beforeInputs: 0, inputs: 0, trusted: true, beforeType: null, inputType: null, inputWasSingleLF: false };
    const ctrl = new AbortController();
    const inputKind = event => ['insertLineBreak', 'insertParagraph', 'insertText'].includes(event.inputType) ? event.inputType : 'other';
    for (const type of ['keydown', 'beforeinput', 'input']) el.ownerDocument.addEventListener(type, event => {
      if (event.target !== el) return;
      t.trusted &&= event.isTrusted;
      if (type === 'keydown') { if (event.key === 'Enter') { t.keys++; key = event; } }
      else if (type === 'beforeinput') { t.beforeInputs++; before = event; t.beforeType = inputKind(event); }
      else { t.inputs++; t.inputType = inputKind(event); t.inputWasSingleLF = el.value === seed + '\x0a'; }
    }, { capture: true, signal: ctrl.signal });
    return () => { ctrl.abort(); return { ...t, keyCanceled: key?.defaultPrevented ?? null,
      beforeCanceled: before?.defaultPrevented ?? null }; };
  }, draft);
  try {
    await field.press('Enter'); await sleep(400);
    Object.assign(probe, await readTrace.evaluate(sample => sample()));
  } finally { await readTrace.dispose(); }
  checkGuard();
  const value = await field.inputValue();
  probe.after = value === draft ? 'unchanged' : value === draft + '\x0a' ? 'one-trailing-LF' : 'other-edit';
  probe.reviewVisible = await review.isVisible();
  probe.originalIntact = probe.reviewVisible && await review.getByLabel('Original recognizer text').inputValue() === raw;
  probe.insertEnabled = probe.reviewVisible && await insert.isEnabled();
  assert.ok(probe.beforeAtEnd && probe.keys === 1 && probe.trusted, 'pending Enter did not hit the seeded caret as a trusted key');
  assert.ok(probe.originalIntact, 'pending Enter dismissed or changed the review');
  if (probe.after === 'unchanged') {
    assert.ok(probe.inputs === 0 && probe.insertEnabled, 'pending Enter modified/reverted the draft or revoked an unchanged review');
  } else {
    assert.ok(probe.after === 'one-trailing-LF' && probe.keyCanceled === false && probe.beforeCanceled === false &&
      probe.beforeInputs === 1 && probe.inputs === 1 && probe.beforeType === 'insertLineBreak' &&
      probe.inputType === 'insertLineBreak' && probe.inputWasSingleLF,
      'pending Enter changed the draft beyond one observed native line break');
    assert.equal(probe.insertEnabled, false, 'editing the draft left the stale dictation insertion enabled');
  }
}

async function main() {
  assert.ok(process.platform === 'linux' && key && process.argv.length === 3, 'Linux, OPENAI_API_KEY and one built checkout required');
  const checkout = fs.realpathSync(process.argv[2]);
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
  const head = git('rev-parse', 'HEAD'), tree = git('rev-parse', 'HEAD^{tree}');
  const expectedHead = 'a58e59097da0089adf1a59ba6c86002a2f407bc5';
  if (process.env.PROOF_EXPECTED_HEAD) assert.equal(process.env.PROOF_EXPECTED_HEAD, expectedHead);
  assert.equal(tree, '46986ece5b94cfcfad805a8648ebc4ae96fc13e6', 'wrong #205788 source tree');
  assert.equal(head, expectedHead, 'build the pinned PR head, not the harness branch or merge ref');
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'tracked checkout is dirty');
  const built = path.join(checkout, 'dist/control-ui');
  assert.ok(fs.existsSync(path.join(built, 'index.html')), 'missing built Control UI');
  const { chromium } = createRequire(path.join(checkout, 'ui/package.json'))('playwright');
  const scenarioBytes = fs.readFileSync(path.join(__dirname, 'scenario.json'));
  assert.equal(sha256(scenarioBytes), '9b6ead98e1f13a210f5a23b12ba2d7970367bf2b58a5e630ec44a9f71161d82b', 'wrong #205788 scenario');
  const scenario = JSON.parse(scenarioBytes.toString('utf8'));
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
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'clips/manifest.json'), 'utf8'));
  verifyClipBindings(clips, manifest, words);
  const output = path.join(__dirname, 'results');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const out = fs.mkdtempSync(path.join(output, 'run-'));
  const tmpParent = fs.realpathSync(process.env.PROOF_TMPFS || '/dev/shm');
  assert.equal(fs.statfsSync(tmpParent).type, 0x01021994, 'private runtime must be on Linux tmpfs');
  assert.equal(fs.readFileSync('/proc/swaps', 'utf8').trim().split('\x0a').length, 1, 'turn off swap before proof');
  const tmp = fs.mkdtempSync(path.join(tmpParent, 'dictation-'));
  const originalTmp = process.env.TMPDIR;
  let gateway, fixture;
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
    fixture = await startCompanionFixture();
    fs.writeFileSync(config, JSON.stringify({
      gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token' },
        controlUi: { enabled: true, root: built } },
      logging: { level: 'silent', file: '/dev/null', consoleLevel: 'warn' }, cron: { enabled: false },
      agents: { defaults: { workspace: path.join(tmp, 'work'), model: { primary: chatModel },
        utilityModel: { primary: fixtureRef, fallbacks: [] }, models: { [chatModel]: {},
          [fixtureRef]: { agentRuntime: { id: 'openclaw' }, params: { transport: 'sse' } } } } },
      models: { providers: { [fixtureProvider]: { baseUrl: fixture.baseUrl, api: 'openai-responses', apiKey: fixtureKey,
        request: { allowPrivateNetwork: true }, models: [{ id: fixtureId, name: 'Local dictation fixture',
          reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
      // Side chat's embedded runner demands at least one of read, sessions_history, sessions_search.
      // The bare minimal profile supplies none. This adds one read-only tool in this disposable Gateway.
      tools: { profile: 'minimal', alsoAllow: ['sessions_history'], media: { audio: { enabled: true, timeoutSeconds: 55, language: 'en' },
        models: [{ provider: 'openai', model: sttModel, capabilities: ['audio'] }] } },
    }), { mode: 0o600 });
    const env = { ...base, OPENCLAW_CONFIG_PATH: config, OPENCLAW_STATE_DIR: path.join(tmp, 'state'),
      OPENCLAW_INTERNAL_WORKER_TMPDIR: path.join(tmp, 'worker-tmp'), OPENCLAW_GATEWAY_TOKEN: token };
    gateway = spawn(process.execPath, ['openclaw.mjs', 'gateway', 'run'], {
      cwd: checkout, env: { ...env, OPENAI_API_KEY: key }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    const warningCount = watchToolFilterWarning([gateway.stdout, gateway.stderr]);
    gateway.on('error', () => {});
    await until(async () => {
      assert.ok(gateway.pid && gateway.exitCode === null && gateway.signalCode === null, 'Gateway exited during startup');
      try { return (await fetch(origin + '/readyz', { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
    }, 'Gateway readyz timeout', 120000);
    const canary = await probeCompanion(checkout, env, fixture, fixtureRef, warningCount);
    write(out, 'companion-preflight.json', JSON.stringify(canary, null, 2) + '\x0a');
    console.log('companion-preflight ' + JSON.stringify(canary)); // Separate from the 33 scored audio takes.
    const tally = [], knownKeys = new Set(); // One private Gateway, all seed/create keys for these takes.
    for (const c of clips) {
      const folder = path.join(out, c.name); fs.mkdirSync(folder, { mode: 0o700 });
      const { surface, policy, finish, after, words: intended } = c.expect;
      const result = { id: c.id, take: c.take, voice: c.voice, head, tree, chatModel, clipSha256: c.hash, surface, policy, finish, after,
        expectedWords: intended, input: 'Chromium fake mic; synthesized WAV', sttModel, alerts: [] };
      let browser, page, box, field, s, render, raw = '', phase = 'connect and configure UI', setup = true;
      const inconclusive = (status, message) => {
        result.status = status;
        result.error = { step: phase, name: 'FixtureQualification', message };
      };
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
        const screenText = await body.evaluate(el => el.innerText + '\x0a' +
          [...el.querySelectorAll('input,textarea,[contenteditable="true"]')]
            .filter(e => e.getClientRects().length).map(e => e.value ?? e.innerText).join('\x0a'), undefined, { timeout: 2000 });
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
          if (policy === 'explicit') {
            const control = explicitControl(intended);
            assert.equal(control?.text, c.expect.proposal, 'bad explicit fixture');
            checkExplicit(clean, control);
          } else {
            assert.equal(clean.text, intended + '.', 'candidate parser failed the clean positive control');
            assert.equal(clean.status, 'refined');
          }
        }
        phase = 'connect and configure UI';
        browser = await chromium.launch({ env: base, args: ['--disable-breakpad', '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + c.clip + '%noloop'] });
        result.chromium = browser.version();
        const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 920 } });
        await context.grantPermissions(['microphone'], { origin });
        page = await context.newPage(); page.setDefaultTimeout(15000);
        await watchAlerts(page, result.alerts, () => phase);
        s = await watchGateway(page, origin, surface, () => phase, knownKeys, chatModel, fixture, warningCount);
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
          s.owner = target; knownKeys.add(target);
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
          if (s.violation) throw new BlockedSubmit('Blocked ' + s.violation.method + ': ' + s.violation.reason);
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
        const control = policy === 'explicit' && recognized ? explicitControl(raw) : null;
        if (policy === 'explicit') result.explicitASR = explicitObservation(raw, intended, Boolean(raw && !s.laterPartial), Boolean(control));
        const sttReason = s.laterPartial ? 'a nonempty partial followed the last final' : !raw ?
          'no nonempty final transcript' : 'final recognizer words did not match the spoken fixture';
        const draftWith = text => draft + ' ' + text;
        if (policy === 'off') {
          phase = 'Off direct insertion';
          if (raw && !s.laterPartial) {
            await until(async () => await field.inputValue() === draftWith(raw), 'Off draft did not receive the exact final transcript');
          }
          assert.equal(await review.isVisible(), false, 'Off must not show review');
          checkGuard();
          if (!recognized) inconclusive('INCONCLUSIVE_STT', sttReason);
          else result.status = 'PASS';
          continue;
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
          inconclusive('INCONCLUSIVE_STT', sttReason); continue;
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
        if (surface === 'new' && after === 'blocked-enter') {
          phase = 'pending review: New Session Enter';
          await probeNewPendingEnter(field, review, raw, result, checkGuard);
        } else {
          if (result.pendingEnterExercised) await field.press('Enter');
          await sleep(400); checkGuard();
          assert.equal(await field.inputValue(), draft, 'pending review actions changed the unsent draft');
        }
        if (!recognized) { inconclusive('INCONCLUSIVE_STT', sttReason); continue; }
        if (policy === 'explicit') {
          phase = 'qualify spoken commands';
          if (!control) {
            inconclusive('INCONCLUSIVE_FIXTURE', 'words matched, but the observed separators or marks were outside the explicit positive control');
            continue;
          }
          // A supported raw input with bad output is a failure, never a fixture miss.
          checkExplicit(refined, control);
          assert.equal(proposed, control.text, 'review did not propose the exact explicit edit');
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
        if (surface === 'side') {
          phase = 'check companion fixture route';
          await until(() => s.companionDefault !== undefined || s.violation, 'no owning companion state receipt', 15000);
          checkGuard();
          assert.equal(s.companionDefault, 'loopback-fixture', 'wrong utility route; refusing to send this CI question');
        }
        phase = 'explicit submit: ' + after;
        render = renderedUserTurns(page, box, surface, inserted);
        s.allow = expectedSubmit(surface, s, target, inserted);
        if (after === 'enter') await field.press('Enter');
        else await sendButton().click();
        phase = 'explicit submit: dispatch';
        await until(() => s.violation || s.sent, 'no outbound ' + s.allow.method + ' after explicit input', 150000);
        checkGuard();
        phase = 'explicit submit: RPC response';
        // At the pinned head: companion ask = 5 min + 10 s; New Session startup = 5 min.
        const replyMs = surface === 'side' ? 315000 : surface === 'new' ? 305000 : 150000;
        await until(() => s.violation || s.sent.accepted !== undefined,
          s.sent.method + ' was forwarded but returned no response in ' + replyMs + ' ms', replyMs);
        checkGuard();
        assert.ok(s.sent.accepted, s.sent.method + ': ' + (s.sent.error || 'invalid Gateway acknowledgment'));
        phase = 'explicit submit: render';
        await until(async () => s.violation || await render.exact.count() > 0,
          'accepted RPC but no visible exact user turn on the intended surface', 15000);
        checkGuard(); await sleep(600); checkGuard();
        result.render = await render.sample();
        assert.equal(result.render.exactVisibleMatches, 1, 'expected one visible exact user turn; got ' + result.render.exactVisibleMatches);
        phase = 'capture submitted turn';
        await capture('submitted', false, render.exact.first());
        result.status = 'PASS';
      } catch (error) {
        const now = await visibleAlerts(page).catch(() => []);
        for (const text of now) recordAlert(result.alerts, phase, text);
        Object.assign(result, classifyError(error, s, setup, phase, result.alerts, now));
      } finally {
        result.finalDraft = await field?.inputValue({ timeout: 500 }).then(scrub, () => null) ?? null;
        if (render && !result.render) result.render = await render.sample().catch(() => ({ unavailable: true }));
        const onFailure = Boolean(s?.violation) || result.status !== 'PASS';
        try { await capture(onFailure ? 'diagnostic' : 'final', onFailure); } catch {}
        for (const text of await visibleAlerts(page).catch(() => [])) recordAlert(result.alerts, phase, text);
        try { await browser?.close(); } catch (error) {
          result.status = 'FAIL'; result.error = { step: 'close browser', ...errorInfo(error) };
        }
        // A blocked request always wins, including on the inconclusive exit paths.
        if (s?.violation) {
          result.status = 'FAIL';
          result.error = { step: s.violation.step,
            ...errorInfo(new BlockedSubmit('Blocked ' + s.violation.method + ': ' + s.violation.reason)) };
        }
        result.recognizer = recognizerReceipt(s, c, words); // Observational; never used to decide PASS.
        result.gatewayEvents = s?.events ?? [];
        result.gatewayError = s?.sttError ?? s?.captureRejected ?? s?.closeRejected ?? null;
        result.gatewayAudioFrames = s?.audio ?? 0;
        result.gatewayAcceptedAudioFrames = s?.audioAccepted ?? 0;
        result.gatewayProvider = s?.provider === 'openai' ? 'openai' : null;
        result.finalAccepted = Boolean(s?.closed && s?.drained);
        collectWireEvidence(result, s, surface);
        result.screenshotAvailable = fs.readdirSync(folder).some(n => n.endsWith('.png'));
        write(folder, 'transcript.txt', scrub(raw || s?.finals.join(' ')) + '\x0a');
        write(folder, 'state.json', JSON.stringify(result, null, 2) + '\x0a');
        tally.push(result);
        console.log(takeLine(c.name, result));
      }
    }
    write(out, 'summary.json', JSON.stringify(tally, null, 2) + '\x0a');
    process.exitCode = !canary.ok || tally.some(x => x.status === 'FAIL' || x.status.startsWith('ERROR')) ? 1 :
      tally.some(x => x.status.startsWith('INCONCLUSIVE_')) ? 2 : 0;
  } finally {
    try { try { await stop(); } finally { await fixture?.close(); } } finally {
      if (originalTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = originalTmp;
      fs.rmSync(tmp, { recursive: true, force: true });
      process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    }
  }
}
main().catch(error => { console.error('Proof setup/cleanup:', JSON.stringify(errorInfo(error))); process.exitCode = 1; });
