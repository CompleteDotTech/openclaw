import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const STABLE = '2026.11.10';
const DRAFT = 'Unsent upgrade fixture: confirm the blue folder.\nKeep this second line.';
const EDIT = DRAFT + '\nCandidate edit: retain this line too.';
const SESSION = 'agent:main:upgrade-proof';
const LABEL = 'Stored upgrade fixture';
const exec = promisify(execFile);
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const report = { stable: STABLE, checks: [], status: 'FAIL' };
let stage = 'verify-inputs';

async function until(test, message, ms = 30_000) {
  const end = Date.now() + ms;
  do {
    if (await test()) return;
    await sleep(100);
  } while (Date.now() < end);
  throw new Error(message);
}

async function main(out) {
  assert(!process.env.OPENAI_API_KEY, 'Offline lane must not receive an OpenAI key');
  assert.equal(process.argv.length, 3);
  const pr = resolve(process.argv[2]);
  assert.equal(pr, resolve(process.env.PROOF_PR_DIR));
  const stable = join(resolve(process.env.PROOF_STABLE_DIR), 'node_modules', 'openclaw');
  assert.equal((await json(join(stable, 'package.json'))).version, STABLE);
  const head = (await exec('git', ['-C', pr, 'rev-parse', 'HEAD'])).stdout.trim();
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.equal(head, process.env.SHA);
  assert.equal((await json(join(pr, 'dist', 'build-info.json'))).commit, head);
  report.candidate = head;
  const { chromium } = createRequire(join(pr, 'ui', 'package.json'))('playwright');
  const root = await mkdtemp(join(tmpdir(), 'dictation-upgrade-'));
  let gateway, browser;
  let blocked = 0;
  const stop = async () => {
    if (!gateway) return;
    const { child, exited } = gateway;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      if (!await Promise.race([exited.then(() => true), sleep(7000, false)])) {
        child.kill('SIGKILL');
        await exited;
        throw new Error('Gateway did not shut down cleanly before switching builds');
      }
    }
    await exited;
    gateway = undefined;
  };
  try {
    const listener = createServer().listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise((ok, fail) => listener.close((err) => err ? fail(err) : ok()));
    const origin = 'http://127.0.0.1:' + port;
    const state = join(root, 'state'), workspace = join(root, 'workspace');
    const profile = join(root, 'chromium');
    const config = join(state, 'openclaw.json');
    const tmp = join(root, 'tmp');
    await Promise.all([state, tmp, workspace].map((path) => mkdir(path)));
    const env = {
      PATH: process.env.PATH, HOME: root, TMPDIR: tmp, TMP: tmp, TEMP: tmp, LANG: 'C.UTF-8',
      OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: config,
      OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_DISABLE_BONJOUR: '1',
    };
    const writeConfig = () => writeFile(config, JSON.stringify({
      gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'none' },
        controlUi: { enabled: true }, tailscale: { mode: 'off' } },
      cron: { enabled: false }, update: { checkOnStart: false }, browser: { enabled: false },
      logging: { level: 'silent', consoleLevel: 'silent' },
      agents: { defaults: { workspace, model: { primary: 'proof-fixture/unused' },
        models: { 'proof-fixture/unused': {} } } },
      models: { providers: { 'proof-fixture': { baseUrl: 'http://127.0.0.1:9/v1',
        api: 'openai-completions', apiKey: 'synthetic-unused-key',
        models: [{ id: 'unused', name: 'Unused fixture model' }] } } },
    }), { mode: 0o600 });
    await writeConfig(); // Never rewrite, copy, or seed the config between versions.
    const cli = async (tree, args) => (await exec(process.execPath, [join(tree, 'openclaw.mjs'), ...args],
      { cwd: root, env, timeout: 30_000, maxBuffer: 512 * 1024 })).stdout.trim();
    const call = async (tree, method, params) => JSON.parse(await cli(tree, [
      'gateway', 'call', method, '--params', JSON.stringify(params), '--json',
    ]));
    const start = async (tree) => {
      let ended = false;
      const child = spawn(process.execPath, [join(tree, 'openclaw.mjs'), 'gateway', 'run',
        '--bind', 'loopback', '--port', String(port)], { cwd: root, env, stdio: 'ignore' });
      gateway = { child, exited: new Promise((done) => {
        for (const event of ['exit', 'error']) child.once(event, () => { ended = true; done(); });
      }) };
      await until(async () => {
        if (ended) throw new Error('Gateway exited before readiness');
        return fetch(origin + '/readyz', { signal: AbortSignal.timeout(1000) })
          .then((res) => res.ok, () => false);
      }, 'Gateway not ready', 120_000);
    };
    const connected = (page) => page.waitForFunction(
      () => window.openclawControlUi?.snapshot().gatewayPhase === 'connected', null, { timeout: 30_000 },
    );
    const open = async () => {
      browser = await chromium.launchPersistentContext(profile, {
        env, locale: 'en-US', colorScheme: 'dark', viewport: { width: 1440, height: 900 },
        serviceWorkers: 'block', acceptDownloads: false,
      });
      await browser.route('**/*', (route) => new URL(route.request().url()).origin === origin
        ? route.continue() : route.abort());
      const page = browser.pages()[0] ?? await browser.newPage();
      await page.routeWebSocket((url) => url.host === new URL(origin).host, (client) => {
        const server = client.connectToServer();
        client.onMessage((payload) => {
          let req;
          try { req = JSON.parse(payload.toString()); } catch { /* forward non-JSON */ }
          if (req?.type === 'req' && ['chat.send', 'sessions.send', 'agent', 'sessions.dispatch',
            'sessions.companion.ask'].includes(req.method)) {
            blocked++;
            client.send(JSON.stringify({ type: 'res', id: req.id, ok: false,
              error: { code: 'INVALID_REQUEST', message: 'No send allowed by upgrade proof' } }));
            return;
          }
          server.send(payload);
        });
      });
      return page;
    };
    const closeBrowser = async () => { await browser.close(); browser = undefined; };
    const frame = async (page, name) => {
      const text = await page.locator('body').innerText();
      const values = await page.locator('textarea:visible, input:visible').evaluateAll((els) => els.map((el) => el.value));
      assert(![text, ...values].some((s) => /\b(?:sk-[\w-]{10,}|Bearer\s+\S+|synthetic-unused-key)/i.test(s)),
        'Unexpected credential-like text; frame withheld');
      await page.screenshot({ path: join(out, name), animations: 'disabled' });
    };
    const appearance = async (page, set) => {
      await page.goto(origin + '/settings/appearance');
      await connected(page);
      const color = page.getByRole('radio', { name: 'Light', exact: true });
      const size = page.locator('#settings-appearance-text-size').getByRole('radio', { name: '110%', exact: true });
      await color.waitFor();
      await size.waitFor();
      if (set) {
        assert(!(await color.isChecked()) && !(await size.isChecked()), 'Seed values must be nondefault');
        await color.click();
        await size.click();
      }
      await until(async () => await color.isChecked() && await size.isChecked() &&
        await page.locator('html').getAttribute('data-theme-mode') === 'light',
      'Existing color mode and text size were not loaded');
    };
    const chat = async (page) => {
      await page.goto(origin + '/chat/main');
      await connected(page);
      const shell = page.locator('.agent-chat__composer-shell:visible');
      const box = shell.getByRole('textbox', { name: 'Chat composer', exact: true });
      await until(async () => await box.isVisible() && await box.isEditable(), 'Chat composer not editable');
      return { box, shell };
    };
    const draftIs = (box, text) => until(async () => await box.inputValue() === text,
      'Persisted draft did not match exact synthetic text');
    const savedSession = async (tree, label, id) => {
      const { sessions } = await call(tree, 'sessions.list', { label, limit: 10 });
      const row = sessions.find((x) => x.key === SESSION);
      assert.equal(row?.sessionId, id, 'Stored session key did not retain its exact session ID');
      assert.equal(row?.label, label, 'Stored session label did not survive');
    };

    stage = 'seed-via-stable';
    assert((await cli(stable, ['--version'])).includes(STABLE), 'Unexpected stable executable');
    await start(stable);
    const created = await call(stable, 'sessions.create', { key: SESSION, agentId: 'main', label: LABEL });
    assert(created.sessionId && !created.runStarted, 'Unexpected stored fixture admission');
    await savedSession(stable, LABEL, created.sessionId);
    let page = await open();
    await appearance(page, true);
    let chatState = await chat(page);
    await chatState.box.fill(DRAFT);
    // Confirm the write using a real navigation; never seed localStorage or IndexedDB.
    await appearance(page, false);
    chatState = await chat(page);
    await draftIs(chatState.box, DRAFT);
    await frame(page, 'stable-draft.png');
    await closeBrowser();

    stage = 'verify-stable-cold-reopen';
    page = await open();
    await appearance(page, false);
    chatState = await chat(page);
    await draftIs(chatState.box, DRAFT);
    assert.equal(await chatState.shell.getByRole('button', { name: 'Dictation cleanup', exact: true }).count(), 0);
    await closeBrowser();
    await stop();
    report.checks.push('Stable wrote and cold-reopened two settings and the exact unsent draft',
      'Stable created and read a real stored session without starting a turn');

    stage = 'upgrade-same-origin-and-state';
    await start(pr);
    await savedSession(pr, LABEL, created.sessionId);
    page = await open();
    await appearance(page, false);
    await frame(page, 'candidate-settings.png');
    chatState = await chat(page);
    await draftIs(chatState.box, DRAFT);
    await frame(page, 'candidate-draft.png');
    await chatState.shell.getByRole('button', { name: 'Dictation cleanup', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Dictation cleanup', exact: true });
    assert.equal(await dialog.getByLabel('Cleanup mode', { exact: true }).inputValue(), 'off');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await draftIs(chatState.box, DRAFT);
    report.checks.push('Candidate loaded stable settings and the exact draft with no reseeding',
      'Candidate defaulted to Off without changing the unsent draft',
      'Candidate read the stable-written session with the same identity and label');

    stage = 'edit-existing-data';
    await call(pr, 'sessions.patch', { key: SESSION, label: LABEL + ' (edited)' });
    await savedSession(pr, LABEL + ' (edited)', created.sessionId);
    await chatState.box.fill(EDIT);
    await appearance(page, false);
    chatState = await chat(page);
    await draftIs(chatState.box, EDIT);
    await closeBrowser();
    page = await open();
    await appearance(page, false);
    chatState = await chat(page);
    await draftIs(chatState.box, EDIT);
    await closeBrowser();
    await stop();
    assert.equal(blocked, 0, 'A test page attempted a send');
    report.checks.push('Candidate updated the saved session and draft; the edited draft survived browser restart',
      'No browser send attempts and no provider calls required');
    report.status = 'PASS';
  } finally {
    report.blockedSendAttempts = blocked;
    try { await browser?.close(); } finally {
      try { await stop(); } finally { await rm(root, { recursive: true, force: true }); }
    }
  }
}

const out = await mkdtemp(join(resolve(process.env.PROOF_RESULTS_DIR), 'upgrade-'));
try {
  await main(out);
} catch (error) {
  report.status = 'FAIL';
  report.failedAt = stage;
  report.errorName = error.name;
  // Keep CLI output/config and browser storage out of uploaded diagnostics.
  report.error = error.cmd ? 'Isolated Gateway/CLI command failed' :
    String(error.message).replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, '[url]').slice(0, 600);
  process.exitCode = 1;
} finally {
  await writeFile(join(out, 'assertions.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Stable upgrade: ' + report.status + (report.failedAt ? ' (' + report.failedAt + ')' : ''));
}
