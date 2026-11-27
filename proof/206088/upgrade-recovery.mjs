import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const STABLE = '2026.11.10';
const INTEGRITY = 'sha512-/FKDjxY1ZdUSXHx1a9b4EUpPRZywM3uv4181g22XImJfp/5+h+fFUZ7B7HthNrdYzq//05zH0Yf7mefzIlWFaQ==';
const DB = 'openclaw-control-ui';
const PREFIX = 'openclaw.control.chatComposer.v4:';
const TAB = 'openclaw.control.outboxTab.v1';
const DRAFT = 'Stable private draft, not sent.';
const QUEUE = 'Stable offline queue, not sent.';
const KEYS = { draft: 'upgrade-draft', queue: 'upgrade-queue', identity: 'upgrade-identity' };
const FILE = { draft: 'draft-fixture.txt', queue: 'queue-fixture.txt' };
const LF = String.fromCharCode(10);
const BYTES = { draft: 'Synthetic stable draft bytes.' + LF, queue: 'Synthetic stable queue bytes.' + LF };
const BASE_REF = '@src/example.ts';
const EDITED_REF = BASE_REF + ' retained';
const REFS = [{ start: 0, end: BASE_REF.length, reference: {
  schemaVersion: 1, namespace: 'openclaw.session-file.v1', providerId: 'session-workspace-local',
  accountId: 'codec-account', workspaceId: 'codec-workspace', rootLabel: 'Synthetic codec fixture',
  authorizationRevision: 'codec-auth', resolverRevision: 'codec-resolver', leaseExpiresAt: 100000,
  objectId: 'codec-opaque-object', relativePath: 'src/example.ts', displayLabel: 'example.ts',
} }];
const CODEC_WRITE = 'identity-codec-fixture';
const COMPOSER = '.agent-chat__composer-shell:visible textarea[aria-label="Chat composer"]';
const EDITOR = '.agent-chat__composer-shell:visible .cm-content[contenteditable="true"]';
const HASH = (data) => createHash('sha256').update(data).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const ordered = (value) => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
const equal = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const check = (condition, code) => { if (!condition) throw new Assertion(code); };
class Assertion extends Error {}
const scope = (name) => 'agent:main:' + KEYS[name] + '\0agent:main';
const result = { stable: STABLE, assertions: [], fixtureEndpoints: 'loopback Gateway and catalog; no provider credentials',
  queueCondition: 'real disconnect during seed; queue readiness RPC held during recovery; no delivery',
  identitySource: 'synthetic durable codec fixture; production hydration and edit, not dictation or resolver',
  tabMetadata: 'exact stable composer/outbox sessionStorage strings carried in memory; no Chromium tab restore claim' };
let stage = 'preflight';
const pass = (name, facts = {}) => result.assertions.push({ name, ...facts });

async function until(read, code, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Assertion(code);
}

async function listen(reply) {
  const server = createServer(reply);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}
const closeServer = (server) => new Promise((done) => server.close(done));

function launchGateway(build, env) {
  const child = spawn(process.execPath, [join(build, 'openclaw.mjs'), 'gateway', 'run', '--bind', 'loopback'], {
    cwd: build, env, stdio: 'ignore', detached: true,
  });
  let closed = false;
  child.on('error', () => {});
  const exit = new Promise((done) => child.once('close', () => { closed = true; done(); }));
  return { live: () => !closed, async close() {
    if (!closed && child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await Promise.race([exit, sleep(8000, undefined, { ref: false })]);
      if (!closed) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        await exit;
        throw new Assertion('gateway-did-not-stop-cleanly');
      }
    } else await exit;
  } };
}

// Native probe, installed before application modules. Does not replace responses or open a database.
function observeOpens(name, readStores) {
  globalThis.upgradeProof = { opens: [] };
  const original = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (...args) {
    const request = Reflect.apply(original, this, args);
    if (args[0] !== name) return request;
    const entry = { requested: args[1] ?? null };
    globalThis.upgradeProof.opens.push(entry);
    request.addEventListener('upgradeneeded', (event) => {
      entry.change = [event.oldVersion, event.newVersion];
    });
    request.addEventListener('success', () => {
      entry.version = request.result.version;
      // Queued before the app's success listener can schedule a writer.
      if (entry.change?.join(':') === '2:3') {
        entry.afterUpgrade = readStores(request.result).catch(() => null);
      }
    });
    request.addEventListener('error', () => { entry.error = request.error?.name; });
    return request;
  };
}

// Read canonical records and real Blob bytes without opening a write transaction.
async function readStores(db) {
  const get = (request) => new Promise((done, fail) => {
    request.onsuccess = () => done(request.result);
    request.onerror = () => fail(new Error('native IDB request failed'));
  });
  const expand = async (value) => {
    if (value instanceof Blob) return { type: value.type, bytes: Array.from(new Uint8Array(await value.arrayBuffer())) };
    if (Array.isArray(value)) return Promise.all(value.map(expand));
    if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(
      Object.entries(value).map(async ([key, entry]) => [key, await expand(entry)]),
    ));
    return value;
  };
  const names = Array.from(db.objectStoreNames).sort();
  const transaction = db.transaction(names, 'readonly');
  const rows = await Promise.all(names.map(async (name) => {
    const store = transaction.objectStore(name);
    const indexes = Array.from(store.indexNames).map((id) => {
      const index = store.index(id);
      return [id, index.keyPath, index.unique, index.multiEntry];
    });
    return [name, { keyPath: store.keyPath, indexes, rows: await expand(await get(store.getAll())) }];
  }));
  return { version: db.version, stores: Object.fromEntries(rows) };
}

async function snapshot(name, readStores) {
  // An absent DB is an error, not a reason to create it.
  if (!(await indexedDB.databases()).some((db) => db.name === name)) return null;
  const opening = indexedDB.open(name);
  opening.onupgradeneeded = () => opening.transaction.abort();
  const db = await new Promise((done, fail) => {
    opening.onsuccess = () => done(opening.result);
    opening.onerror = () => fail(new Error('native IDB open failed'));
  });
  try { return await readStores(db); } finally { db.close(); }
}

function tabData([prefix, tab]) {
  return Object.keys(sessionStorage).filter((key) => key.startsWith(prefix) || key === tab)
    .sort().map((key) => [key, sessionStorage.getItem(key)]);
}

function tabRow(data, name) {
  const hits = data.filter(([key]) => key.startsWith(PREFIX)).flatMap(([key, raw]) => {
    const store = JSON.parse(raw);
    return store.sessions?.[scope(name)] ? [{ key, raw, store, row: store.sessions[scope(name)] }] : [];
  });
  check(hits.length <= 1, 'ambiguous-tab-owner');
  return hits[0];
}
function rowFor(db, name) {
  const hits = db?.stores.composerDrafts.rows.filter((row) => row.scopeKey === 'chat:v3:' + scope(name)) ?? [];
  check(hits.length <= 1, 'ambiguous-durable-owner');
  return hits[0];
}
function checkPayload(attachments, name) {
  check(attachments?.length === 1 && attachments[0].fileName === FILE[name] &&
    attachments[0].mimeType === 'text/plain' &&
    equal(attachments[0].blob.bytes, [...Buffer.from(BYTES[name])]), name + '-attachment-bytes');
}

async function readVersion(page, version, verdict) {
  await page.waitForFunction(([version, verdict]) => globalThis.upgradeProof.opens.some((open) =>
    open.requested === version && (verdict === 'VersionError' ? open.error === verdict :
      open.version === version && (verdict === 'upgrade' ? open.change?.join(':') === '2:3' :
        verdict === 'created' ? open.change?.join(':') === '0:2' : !open.change))),
  [version, verdict]);
}

async function seedIdentity(page, owner) {
  const data = { gatewayOwner: owner.gatewayOwner, recoveryScope: owner.recoveryScope,
    scopeKey: 'chat:v3:' + scope('identity'), text: BASE_REF, fileReferences: REFS, writeId: CODEC_WRITE };
  await page.evaluate(async ([name, data]) => {
    const opened = indexedDB.open(name, 3);
    const db = await new Promise((done, fail) => {
      opened.onupgradeneeded = () => opened.transaction.abort();
      opened.onsuccess = () => done(opened.result);
      opened.onerror = () => fail(new Error('codec fixture open failed'));
    });
    try {
      const tx = db.transaction('composerDrafts', 'readwrite', { durability: 'strict' });
      await new Promise((done, fail) => {
        tx.oncomplete = done;
        tx.onabort = () => fail(new Error('codec fixture write failed'));
        const owner = [data.gatewayOwner, data.recoveryScope];
        tx.objectStore('composerDrafts').add({ ...data,
          key: JSON.stringify([...owner, data.scopeKey]), ownerKey: JSON.stringify(owner),
          revision: Date.now(), updatedAt: Date.now(), attachments: [],
        });
      });
    } finally { db.close(); }
  }, [DB, data]);
}

async function run(pr, stable, scratch) {
  const binding = await json(join(dirname(resolve(process.env.PROOF_RESULTS_DIR)), 'source.json'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: pr, encoding: 'utf8' }).trim();
  check(/^[0-9a-f]{40}$/.test(head) && head === binding.head, 'wrong-pr-head');
  result.head = head;
  const stableBuild = join(stable, 'node_modules/openclaw');
  const stablePackage = await json(join(stableBuild, 'package.json'));
  const lock = (await json(join(stable, 'package-lock.json'))).packages['node_modules/openclaw'];
  check(stablePackage.version === STABLE && stablePackage.bin.openclaw === 'openclaw.mjs' &&
    lock.version === STABLE && lock.integrity === INTEGRITY, 'wrong-npm-release');
  // A caller's debug flags must not leak browser or RPC details to the workflow log.
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;
  const { chromium } = createRequire(join(pr, 'ui/package.json'))('playwright');
  let gateway, browser, model;
  let attemptedSends = 0, heldReads = 0, inference = 0;
  try {
    const reserve = await listen();
    const { port } = reserve.address();
    await closeServer(reserve);
    const origin = 'http://127.0.0.1:' + port;
    const probe = origin + '/__upgrade_proof_blank';
    // Keyless, loopback-only Ollama catalog fixture. No generation endpoint is implemented.
    model = await listen((request, response) => {
      const path = (request.url ?? '').split('?')[0];
      response.setHeader('Content-Type', 'application/json');
      const info = { model: 'storage-proof', name: 'storage-proof', details: { family: 'llama' } };
      if (request.method === 'GET' && path === '/api/tags') response.end(JSON.stringify({ models: [info] }));
      else if (path === '/api/show') response.end(JSON.stringify({ ...info, capabilities: ['completion'] }));
      else if (path === '/api/version') response.end(JSON.stringify({ version: '0.20.0' }));
      else { if (/chat|generate|completions/.test(path)) inference++; response.writeHead(404).end(); }
    });
    const local = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: scratch, TMPDIR: scratch,
      TMP: scratch, TEMP: scratch, XDG_CONFIG_HOME: join(scratch, 'xdg-config'),
      XDG_CACHE_HOME: join(scratch, 'xdg-cache'), XDG_DATA_HOME: join(scratch, 'xdg-data'),
      XDG_STATE_HOME: join(scratch, 'xdg-state'), OPENCLAW_HOME: scratch, OPENCLAW_SKIP_CHANNELS: '1',
      OPENCLAW_GATEWAY_PORT: String(port), NODE_DISABLE_COMPILE_CACHE: '1' };
    const config = join(scratch, 'config.json');
    const initialState = join(scratch, 's2');
    const initialProfile = join(scratch, 'p2');
    const upgradedState = join(scratch, 's3');
    const upgradedProfile = join(scratch, 'p3');
    const backupState = join(scratch, 's2r');
    const backupProfile = join(scratch, 'p2r');
    const oldState = join(scratch, 's2old');
    const workspace = join(scratch, 'workspace');
    await mkdir(workspace);

    const start = async (build, state, label) => {
      stage = label + '-gateway';
      const ui = join(build, 'dist/control-ui');
      const body = await readFile(join(ui, 'index.html'), 'utf8');
      const entry = body.match(/<script\b[^>]*\bsrc=["']([^"']+\.js)["']/)?.[1];
      check(entry && /^\.?\/?assets\/[\w.-]+\.js$/.test(entry), 'missing-production-ui-entry');
      const assetHash = HASH(await readFile(join(ui, entry)));
      const env = { ...local, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: config };
      await writeFile(config, JSON.stringify({
        gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'none' }, controlUi: { enabled: true } },
        agents: { defaults: { workspace, heartbeat: { every: '0m' }, model: { primary: 'ollama/storage-proof' } } },
        models: { providers: { ollama: { api: 'ollama', baseUrl: 'http://127.0.0.1:' + model.address().port,
          models: [{ id: 'storage-proof', name: 'Storage proof', input: ['text'], contextWindow: 8192, maxTokens: 1024 }],
        } } }, plugins: { entries: { ollama: { enabled: true } } },
        update: { checkOnStart: false },
        logging: { file: join(state, 'gateway.log') },
      }), { mode: 0o600 });
      gateway = launchGateway(build, env);
      await until(async () => {
        check(gateway.live(), 'gateway-exited-before-ready');
        return (await fetch(origin + '/readyz', { signal: AbortSignal.timeout(2000) }).catch(() => null))?.ok;
      }, 'gateway-not-ready', 120_000);
      const downloaded = await fetch(new URL(entry, origin), { signal: AbortSignal.timeout(5000) });
      check(downloaded.ok && HASH(new Uint8Array(await downloaded.arrayBuffer())) === assetHash, 'served-ui-build-mismatch');
      pass(label + '-build-served', { entrySha256: assetHash });
      return env;
    };
    const stop = async () => { await gateway.close(); gateway = undefined; };
    const launch = async (profile, data = [], hold = false) => {
      browser = await chromium.launchPersistentContext(profile, { env: local, headless: true,
        serviceWorkers: 'block', locale: 'en-US', viewport: { width: 1280, height: 900 },
        args: ['--no-first-run', '--no-default-browser-check'],
      });
      const page = browser.pages()[0] ?? await browser.newPage();
      if (!result.chromium) {
        const cdp = await browser.newCDPSession(page);
        const { product } = await cdp.send('Browser.getVersion');
        check(/^(?:HeadlessChrome|Chrome)\/[0-9.]+$/.test(product), 'not-chromium');
        result.chromium = product;
        await cdp.detach();
      }
      page.setDefaultTimeout(35_000);
      await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.route(probe, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Storage observer</title>' }));
      await page.routeWebSocket((url) => url.host === new URL(origin).host, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          let request;
          try { request = JSON.parse(message.toString()); } catch { return; }
          const { method, params } = request;
          if (['chat.send', 'sessions.send', 'sessions.steer', 'agent'].includes(method)) { attemptedSends++; return; }
          if (hold && method === 'chat.history' && params?.sessionKey === 'agent:main:' + KEYS.queue && params.limit === 1) {
            heldReads++;
            return;
          }
          server.send(message);
        });
      });
      await page.goto(probe);
      await page.evaluate(({ data, prefix, tab }) => {
        for (const key of Object.keys(sessionStorage)) {
          if (key.startsWith(prefix) || key === tab) sessionStorage.removeItem(key);
        }
        for (const [key, value] of data) sessionStorage.setItem(key, value);
      }, { data, prefix: PREFIX, tab: TAB });
      await page.addInitScript({ content: `(${observeOpens})(${JSON.stringify(DB)}, ${readStores});` });
      return page;
    };
    const closeBrowser = async () => { await browser.close(); browser = undefined; };
    const go = async (page, name) => {
      const response = await page.goto(origin + '/chat/main/' + KEYS[name], { waitUntil: 'domcontentloaded' });
      check(response?.ok(), 'chat-page-http');
      await page.waitForFunction(() => window.openclawControlUi?.snapshot().gatewayPhase === 'connected');
      const composer = page.locator(COMPOSER);
      await composer.waitFor({ state: 'attached' });
      return composer;
    };
    const tabRead = (page) => page.evaluate(tabData, [PREFIX, TAB]);
    const dbRead = (page) => page.evaluate(`(${snapshot})(${JSON.stringify(DB)}, ${readStores})`);
    const value = (locator, text) => until(async () => await locator.inputValue() === text, 'composer-text');
    const queueMark = (page) => page.locator('.chat-queue__item:visible').getByText(QUEUE, { exact: true });
    const pick = (page, name) => page.locator('.agent-chat__composer-shell:visible .agent-chat__file-input')
      .setInputFiles({ name: FILE[name], mimeType: 'text/plain', buffer: Buffer.from(BYTES[name]) });

    const stableEnv = await start(stableBuild, initialState, 'stable-seed');
    stage = 'stable-real-sessions';
    for (const name of Object.keys(KEYS)) {
      execFileSync(process.execPath, [join(stableBuild, 'openclaw.mjs'), 'gateway', 'call', 'sessions.create',
        '--expect-url', origin.replace('http:', 'ws:'), '--timeout', '30000', '--json',
        '--params', JSON.stringify({ agentId: 'main', key: 'agent:main:' + KEYS[name], label: KEYS[name] }),
      ], { cwd: stableBuild, env: stableEnv, timeout: 45_000, stdio: 'ignore' });
    }
    let page = await launch(initialProfile);
    stage = 'stable-draft-ui';
    await (await go(page, 'draft')).fill(DRAFT);
    await pick(page, 'draft');
    await readVersion(page, 2, 'created');
    const stableDraft = await until(async () => {
      const row = rowFor(await dbRead(page), 'draft');
      return row?.text === DRAFT && row.attachments.length === 1 && row;
    }, 'stable-draft-not-durable');
    checkPayload(stableDraft.attachments, 'draft');
    stage = 'stable-offline-queue-ui';
    const queueComposer = await go(page, 'queue');
    await queueComposer.fill(QUEUE);
    await pick(page, 'queue');
    await page.locator('.chat-attachment-thumb:visible').waitFor();
    await stop();
    await page.waitForFunction(() => window.openclawControlUi?.snapshot().gatewayPhase === 'reconnecting');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await queueMark(page).waitFor();
    await until(async () => {
      const row = rowFor(await dbRead(page), 'queue');
      return !row || (!row.text && !row.attachments.length);
    }, 'stable-queue-source-draft-not-cleared');
    const stableQueue = await until(async () => {
      const row = tabRow(await tabRead(page), 'queue');
      return row?.store.version === 4 && row.row.queue?.find((item) => item.text === QUEUE && item.attachmentPayload);
    }, 'stable-queue-not-durable');
    check(stableQueue.sendAttempts === 0 && !!stableQueue.sendRunId, 'stable-queue-attempted');
    const initial = await dbRead(page);
    const initialTab = await tabRead(page);
    check(initial.version === 2 && rowFor(initial, 'draft')?.text === DRAFT &&
      tabRow(initialTab, 'draft')?.row.draft === DRAFT, 'incomplete-stable-baseline');
    checkPayload(initial.stores.outboxPayloads.rows.find((row) => row.key === stableQueue.attachmentPayload.key)?.attachments, 'queue');
    await closeBrowser();
    await cp(initialProfile, upgradedProfile, { recursive: true, errorOnExist: true, force: false });
    await cp(initialProfile, backupProfile, { recursive: true, errorOnExist: true, force: false });
    for (const dest of [upgradedState, backupState, oldState]) {
      await cp(initialState, dest, { recursive: true, errorOnExist: true, force: false });
    }
    pass('stable-ui-seeded-v2', { stableFormat: 4, draftBlobBytes: Buffer.byteLength(BYTES.draft), queueBlobBytes: Buffer.byteLength(BYTES.queue) });

    async function checkQueue(page) {
      await go(page, 'queue');
      await queueMark(page).waitFor();
      const row = tabRow(await tabRead(page), 'queue')?.row.queue;
      check(row?.length === 1 && row[0].id === stableQueue.id && row[0].sendRunId === stableQueue.sendRunId &&
        row[0].text === QUEUE && row[0].sendAttempts === 0 && row[0].attachmentPayload, 'queue-not-preserved');
      const record = (await dbRead(page)).stores.outboxPayloads.rows.find((entry) => entry.key === row[0].attachmentPayload.key);
      checkPayload(record?.attachments, 'queue');
    }
    async function checkDraft(page) {
      const composer = await go(page, 'draft');
      await value(composer, DRAFT);
      await page.locator('.chat-attachment-thumb:visible').waitFor();
      checkPayload(rowFor(await dbRead(page), 'draft')?.attachments, 'draft');
    }
    async function checkRef(page, text) {
      const composer = page.locator(COMPOSER);
      await value(composer, text);
      const chip = page.locator('.chat-composer-file-reference:visible');
      await chip.waitFor();
      check((await chip.textContent())?.trim() === BASE_REF, 'identity-chip-text');
      return composer;
    }

    await start(pr, upgradedState, 'pr-upgrade');
    stage = 'closed-backup-v2-readback';
    page = await launch(upgradedProfile, initialTab, true);
    check(equal(initial, await dbRead(page)), 'closed-profile-copy-differs');
    stage = 'production-v2-to-v3';
    await checkDraft(page);
    await readVersion(page, 3, 'upgrade');
    const atUpgrade = await page.evaluate(() => globalThis.upgradeProof.opens.find((entry) => entry.afterUpgrade)?.afterUpgrade);
    check(equal(atUpgrade, { ...initial, version: 3 }), 'upgrade-changed-original-schema-or-rows');
    await checkQueue(page);
    pass('production-upgrade-and-stable-content', { indexedDB: [2, 3], retainedStores: Object.keys(initial.stores).length });

    stage = 'codec-fixture-production-format5';
    await page.goto(probe);
    await seedIdentity(page, stableDraft);
    await go(page, 'identity');
    await checkRef(page, BASE_REF);
    await page.locator(EDITOR).press('End');
    await page.keyboard.insertText(' retained');
    await checkRef(page, EDITED_REF);
    const format5 = await until(async () => {
      const candidate = tabRow(await tabRead(page), 'identity');
      return candidate?.store.version === 5 && candidate.row.draft === EDITED_REF &&
        equal(candidate.row.draftFileReferences, REFS) && candidate;
    }, 'production-format5-not-written');
    const identity = await until(async () => {
      const candidate = rowFor(await dbRead(page), 'identity');
      return candidate?.text === EDITED_REF && candidate.writeId !== CODEC_WRITE &&
        equal(candidate.fileReferences, REFS) && candidate;
    }, 'production-identity-not-written');
    const upgraded = await dbRead(page);
    const upgradedTab = await tabRead(page);
    check(upgraded.version === 3 && upgradedTab.find(([key]) => key === format5.key)?.[1] === format5.raw, 'unstable-format5');
    await closeBrowser();
    await stop();
    pass('production-format5-and-identity-rewrite', { tabFormat: 5, identitySource: 'codec fixture', completeReferenceMatched: true });

    await start(stableBuild, oldState, 'old-reopen');
    stage = 'old-production-open-refusal';
    page = await launch(upgradedProfile, upgradedTab, true);
    check(equal(upgraded, await dbRead(page)), 'upgraded-profile-copy-differs');
    await go(page, 'identity');
    await readVersion(page, 2, 'VersionError');
    check(await page.locator(COMPOSER).inputValue() !== EDITED_REF, 'old-build-exposed-identity-as-text');
    const oldTab = await tabRead(page);
    check(oldTab.find(([key]) => key === format5.key)?.[1] === format5.raw, 'old-build-changed-format5');
    check(equal(upgraded, await dbRead(page)), 'old-build-changed-v3-db');
    await closeBrowser();
    await stop();
    pass('old-production-build-refused-v3', { requested: 2, nativeError: 'VersionError', databaseUnchanged: true, format5Unchanged: true });

    await start(pr, upgradedState, 'compatible-reopen');
    stage = 'compatible-reopen-after-old-refusal';
    page = await launch(upgradedProfile, oldTab, true);
    await go(page, 'identity');
    await readVersion(page, 3, 'reopen');
    await checkRef(page, EDITED_REF);
    const recoveredTab = tabRow(await tabRead(page), 'identity');
    check(recoveredTab?.store.version === 5 && equal(recoveredTab.row.draftFileReferences, REFS), 'compatible-format5-not-readable');
    await checkQueue(page);
    await closeBrowser();
    // New Chromium context without the tab copy: v3 alone must hydrate the reference.
    page = await launch(upgradedProfile, oldTab.filter(([key]) => key === TAB), true);
    await go(page, 'identity');
    await readVersion(page, 3, 'reopen');
    await checkRef(page, EDITED_REF);
    check(equal(rowFor(await dbRead(page), 'identity')?.fileReferences, identity.fileReferences), 'identity-changed-after-old-refusal');
    await until(async () => tabRow(await tabRead(page), 'identity')?.store.version === 5, 'compatible-format5-not-restored');
    await closeBrowser();
    await stop();
    pass('compatible-reopen-after-old-refusal', { databaseVersion: 3, identityRestoredFromDurableOnly: true });

    await start(stableBuild, backupState, 'original-backup');
    stage = 'original-backup-restored';
    page = await launch(backupProfile, initialTab, true);
    check(equal(initial, await dbRead(page)), 'original-backup-differs');
    await checkDraft(page);
    await readVersion(page, 2, 'reopen');
    await checkQueue(page);
    check(tabRow(await tabRead(page), 'queue')?.store.version === 4, 'backup-format-not-v4');
    check(attemptedSends === 0 && inference === 0, 'unexpected-delivery-or-inference');
    pass('original-v2-backup-usable-on-stable', { indexedDB: 2, tabFormat: 4, draftAndQueueRestored: true });
    pass('delivery-and-inference-not-attempted', { attemptedSends, inference, heldReadinessRequests: heldReads });
  } finally {
    const cleanup = await Promise.allSettled([browser?.close(), gateway?.close(), model && closeServer(model)]);
    check(cleanup.every((entry) => entry.status === 'fulfilled'), 'private-process-cleanup-failed');
  }
}

async function main() {
  check(process.env.PROOF_PR_DIR && process.env.PROOF_STABLE_DIR && process.env.PROOF_RESULTS_DIR, 'missing-workflow-paths');
  const pr = resolve(process.env.PROOF_PR_DIR);
  check(!process.argv[2] || resolve(process.argv[2]) === pr, 'pr-path-mismatch');
  const base = join(dirname(pr), '.openclaw/tmp/payload-proof');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(base, 'idb-'));
  try {
    await run(pr, resolve(process.env.PROOF_STABLE_DIR), scratch);
    result.status = 'PASS';
  } catch (error) {
    result.status = 'FAIL';
    result.failure = { stage, code: error instanceof Assertion ? error.message : 'runtime-or-browser-assertion' };
  } finally {
    try { await rm(scratch, { recursive: true, force: true, maxRetries: 3 }); result.scratchRemoved = true; }
    catch { result.status = 'FAIL'; result.scratchRemoved = false; }
  }
  const out = resolve(process.env.PROOF_RESULTS_DIR);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'upgrade-recovery.json'), JSON.stringify(result, null, 2) + LF, { mode: 0o600, flag: 'wx' });
  console.log('upgrade-recovery: ' + result.status + (result.failure ? ' (' + result.failure.stage + ')' : ''));
  if (result.status !== 'PASS') process.exitCode = 1;
}

main().catch(() => { console.error('upgrade-recovery: harness preflight or result write failed'); process.exitCode = 1; });
