// Offline lane for #206088: regenerate the Control UI boot manifest in a disposable
// checkout of the PR head and report whether the tracked manifest changes.
// Needs a "manifest" checkout of the same commit in run.json. Runs before any secret.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const trees = JSON.parse(process.env.PROOF_CHECKOUTS || '{}');
const dir = trees.manifest;
if (!dir) throw new Error('Add a "manifest" checkout of the PR head to run.json');

const headOf = (cwd) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
const head = headOf(dir);
if (head !== headOf(process.env.PROOF_PR_DIR)) throw new Error('The manifest checkout is not the PR head');

const file = 'ui/config/control-ui-boot-modules.json';
const out = path.join(process.env.PROOF_RESULTS_DIR, 'boot-manifest');
mkdirSync(out, { recursive: true });

// The generator builds its own bundle and loads it in Playwright's Chromium.
execFileSync('pnpm', ['run', 'ui:boot-manifest:gen'], { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] });

const diff = execFileSync('git', ['diff', '--', file], { cwd: dir, encoding: 'utf8' });
writeFileSync(path.join(out, 'manifest.diff'), diff);
writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ head, file, changed: diff.length > 0 }, null, 2) + '\n');
console.log(diff ? `${file} changed after regeneration; the diff is in boot-manifest/manifest.diff` : `${file} is unchanged after regeneration`);
if (diff) process.exitCode = 1;
