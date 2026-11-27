// proof/205875/receipt-proof.mjs
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const head = '42d18e81a786e78774845471189a20274054557f';
const tree = '97ad421d695f189afca0b0543bbddd8fae5238f1';
const rig = 'scripts/dev/computer-use-macos-live-rig.sh';
const target = 'OpenClaw Receipt Fixture';
const sentinel = 'OpenClaw Receipt Sentinel';
const nodeName = 'OpenClaw CUA X11 Live Proof';
const port = '29431';
const node = process.execPath;
const run = promisify(execFile);
let phase = 'preflight';

function requireProof(ok) {
  if (!ok) throw new Error('proof assertion failed');
}

async function poll(probe, seconds) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (await probe()) return;
    await sleep(500);
  }
  throw new Error('readiness timed out');
}

async function desktop(repo, scratch, results) {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const owned = [];
  const launch = (cmd, args) => {
    const child = spawn(cmd, args, { cwd: repo, detached: true, stdio: 'ignore' });
    const done = new Promise((resolve) => {
      child.once('error', resolve);
      child.once('close', resolve);
    });
    owned.push({ child, done });
  };
  const command = async (cmd, args, timeout = 10_000) =>
    (await run(cmd, args, { cwd: repo, timeout, signal: abort.signal })).stdout.trim();
  const probe = async (cmd, args) => {
    try { return await command(cmd, args); }
    catch { abort.signal.throwIfAborted(); return ''; }
  };
  const rigArgs = (action, ...args) => [rig, action, scratch, ...args];
  const nodes = async () => {
    const json = await probe('bash', rigArgs('nodes'));
    try { return JSON.parse(json); } catch { return null; }
  };
  const signalGroup = ({ child }, signal) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };

  let evidence;
  try {
    phase = 'x11-window-manager';
    launch('openbox', []);
    await poll(async () => /window id # 0x[1-9a-f]/i.test(
      await probe('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK']),
    ), 20);

    phase = 'prepare-loopback-rig';
    await command('bash', [rig, 'prepare-linux', 'receipt205875', port, scratch]);

    phase = 'gtk-fixture';
    launch('bash', rigArgs('fixture', target, sentinel, 'P05 RECEIPT BEFORE'));
    await poll(async () =>
      (await probe('xdotool', ['getactivewindow', 'getwindowname'])) === sentinel, 20);

    phase = 'gateway-ready';
    launch('bash', rigArgs('gateway'));
    await poll(async () => Array.isArray((await nodes())?.paired), 120);

    phase = 'paired-cua-ready';
    launch('bash', rigArgs('node'));
    let approved = false;
    await poll(async () => {
      const status = await nodes();
      if (!status) return false;
      const pending = status.pending ?? [];
      if (!approved && pending.length) {
        const [request] = pending;
        // Approve only the sole node request on this disposable loopback Gateway.
        requireProof(pending.length === 1 && request.displayName === nodeName &&
          typeof request.requestId === 'string');
        await command('bash', rigArgs('approve', request.requestId), 30_000);
        approved = true;
        return false;
      }
      const connected = (status.paired ?? []).filter((row) => row.connected);
      return connected.length === 1 && connected[0].displayName === nodeName &&
        connected[0].computerUse?.provider?.id === 'cua-computer' &&
        connected[0].commands?.includes('computer.act') &&
        connected[0].commands?.includes('screen.snapshot');
    }, 120);

    phase = 'native-receipt';
    const raw = join(scratch, 'receipt');
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: join(scratch, 'gateway.json'),
      OPENCLAW_STATE_DIR: join(scratch, 'agent-state'),
      OPENCLAW_GATEWAY_PORT: port,
    };
    // One invocation of the checked-in proof. Only readiness probes are retried.
    const verdict = await run(node, [
      '--import', './scripts/tsx.mjs', 'scripts/dev/computer-use-effect-receipt-proof.ts',
      '--window-title', target, '--artifacts', raw,
    ], { cwd: repo, env, timeout: 240_000, signal: abort.signal }).then(() => true, () => false);
    const r = await readFile(join(raw, 'result.json'), 'utf8').then(JSON.parse, () => null);
    if (r && !verdict && typeof r.phase === 'string' && typeof r.failure === 'string' &&
        /^[a-z-]{1,48}$/.test(r.phase) && /^[a-z_-]{1,64}$/.test(r.failure)) {
      console.log(`proof runner: phase=${r.phase}, assertion=${r.failure}`);
    }
    requireProof(verdict && r?.ok === true && r.failure === null &&
      r.source?.commit === head && r.source.tree === tree && r.source.trackedRuntimeClean === true &&
      /^[a-f0-9]{64}$/.test(r.source.harnessSha256) &&
      r.runtime?.platform === 'linux' && r.runtime.version === process.version &&
      r.provider?.id === 'cua-computer' && r.action?.name === 'type' && r.action.ok === true &&
      r.action.deliveryMode === 'background' && r.action.attempts === 1 &&
      ['unverifiable', 'suspected_noop'].includes(r.action.effect) &&
      r.observation?.beforeMatchesFixture === true && r.observation.followUpOk === true &&
      r.observation.freshWindowObservation === true && r.observation.markerOccurrences === 1 &&
      r.receipt?.executionStarted === true && r.receipt.privateState === 'uncertain' &&
      r.receipt.terminalState === 'uncertain');

    evidence = {
      ok: true, commit: head, tree, harnessSha256: r.source.harnessSha256,
      runtime: {
        platform: 'linux', display: 'Xvfb/X11', node: process.version,
        runner: process.env.RUNNER_ENVIRONMENT === 'github-hosted'
          ? 'GitHub-hosted Actions' : 'not identified',
      },
      route: 'computer tool -> Gateway node.invoke -> paired Linux CUA -> terminal observer',
      provider: 'cua-computer', action: 'background type', attempts: r.action.attempts,
      providerEffect: r.action.effect, beforeMatchesFixture: true, freshWindowReadback: true,
      markerOccurrences: r.observation.markerOccurrences, executionStarted: true,
      privateReceipt: r.receipt.privateState, terminalReceipt: r.receipt.terminalState,
    };
  } finally {
    // Stop and join only our own process groups. The wrappers own Xvfb and D-Bus.
    owned.slice().reverse().forEach((p) => signalGroup(p, 'SIGTERM'));
    if (owned.length) await sleep(1000);
    owned.forEach((p) => signalGroup(p, 'SIGKILL'));
    await Promise.all(owned.map((p) => p.done));
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }

  abort.signal.throwIfAborted();
  phase = 'retain-allowlisted-result';
  await writeFile(join(results, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', {
    flag: 'wx', mode: 0o600,
  });
  console.log(`PASS #205875 commit=${head} tree=${tree} ${evidence.runtime.runner}; Linux Xvfb/X11; Node ${process.version}`);
  console.log(`Real ${evidence.route}; one background type; provider effect=${evidence.providerEffect}`);
  console.log('Fresh window readback: marker exactly once. Original private and terminal receipts: uncertain (not mutation_committed).');
}

async function main() {
  const [, , arg, ...rest] = process.argv;
  if (arg === '--inside-xvfb') return desktop(...rest);

  const requested = arg ?? process.env.PROOF_PR_DIR;
  requireProof(requested && process.env.PROOF_RESULTS_DIR && process.platform === 'linux');
  const repo = await realpath(requested);
  if (process.env.PROOF_PR_DIR) requireProof(repo === await realpath(process.env.PROOF_PR_DIR));
  const results = resolve(process.env.PROOF_RESULTS_DIR);
  const git = async (...args) => (await run('git', args, { cwd: repo })).stdout.trim();
  requireProof(await git('rev-parse', 'HEAD') === head && await git('rev-parse', 'HEAD^{tree}') === tree);
  await git('diff', '--quiet', 'HEAD', '--');

  phase = 'exact-head-build-stamps';
  for (const name of ['.buildstamp', '.runtime-postbuildstamp']) {
    const stamp = JSON.parse(await readFile(join(repo, 'dist', name), 'utf8'));
    requireProof(stamp.head === head && stamp.inputsClean === true);
  }

  await mkdir(results, { recursive: true });
  const scratch = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), 'receipt205875-'));
  try {
    phase = 'xvfb-dbus-session';
    const home = join(scratch, 'home');
    await mkdir(home, { mode: 0o700 });
    const child = spawn('xvfb-run', [
      '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp',
      'dbus-run-session', '--', node, fileURLToPath(import.meta.url),
      '--inside-xvfb', repo, scratch, results,
    ], {
      cwd: repo, detached: true, stdio: ['ignore', 'inherit', 'ignore'],
      env: {
        // System Python sees the apt-installed GTK bindings. Keep the pinned Node first.
        PATH: [dirname(node), '/usr/bin', '/bin', process.env.PATH].filter(Boolean).join(':'),
        HOME: home, TMPDIR: scratch, LANG: 'C.UTF-8', CI: 'true',
        XDG_SESSION_TYPE: 'x11', NO_AT_BRIDGE: '0', GDK_BACKEND: 'x11',
        RUNNER_ENVIRONMENT: process.env.RUNNER_ENVIRONMENT === 'github-hosted' ? 'github-hosted' : '',
      },
    });
    const interrupt = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    process.on('SIGTERM', interrupt);
    process.on('SIGINT', interrupt);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      requireProof(code === 0);
    } finally {
      process.off('SIGTERM', interrupt);
      process.off('SIGINT', interrupt);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

try { await main(); }
catch {
  // Never print raw subprocess output, Gateway configs, node state, or tokens.
  console.log(`FAIL #205875 phase=${phase}`);
  process.exitCode = 1;
}
