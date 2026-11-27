import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

const HEAD = "935d686591746fbeff2335e14877213679340635";
const BASE = "af23a024cf8ef3e7793976ea54cb0191b03044ab";
const BASE_NAME = "pre-fix";

const cases = [
  {
    id: "shadowed-alias",
    file: "src/realtime-transcription/vocabulary-terms.test.ts",
    config: "test/vitest/vitest.unit-src.config.ts",
    title: "ignores aliases from shared terms shadowed by a personal canonical override",
    sources: ["src/realtime-transcription/vocabulary-terms.ts"],
    line: 210,
    failure: /^AssertionError: expected .* to deeply equal /m,
  },
  {
    id: "provider-admission",
    file: "src/gateway/talk/transcription-relay.vocabulary.test.ts",
    config: "test/vitest/vitest.gateway.config.ts",
    title: "requires a new vocabulary admission after provider creation fails",
    sources: [
      "src/gateway/talk/transcription-relay.ts",
      "src/realtime-transcription/vocabulary-snapshot.ts",
    ],
    line: 176,
    failure: /^AssertionError: expected function to throw an error, but it didn't/m,
  },
];

function required(value, name) {
  assert(typeof value === "string" && value.length > 0, `Missing ${name}`);
  return value;
}

const head = realpathSync(required(process.argv[2], "argv[2]"));
assert.equal(
  head,
  realpathSync(required(process.env.PROOF_PR_DIR, "PROOF_PR_DIR")),
  "argv[2] and PROOF_PR_DIR disagree",
);
const checkouts = JSON.parse(required(process.env.PROOF_CHECKOUTS, "PROOF_CHECKOUTS"));
const base = realpathSync(required(checkouts[BASE_NAME], `checkout ${BASE_NAME}`));
assert.notEqual(base, head, "Head and base must be separate checkouts");
assert(!process.env.OPENAI_API_KEY, "Run this lane without OPENAI_API_KEY");

const results = path.resolve(required(process.env.PROOF_RESULTS_DIR, "PROOF_RESULTS_DIR"));
mkdirSync(results, { recursive: true });
const out = mkdtempSync(path.join(results, "red-green-"));
console.log(`Red/green artifacts: ${out}`);

const env = {};
for (const key of [
  "PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP",
  "COREPACK_HOME", "PNPM_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
Object.assign(env, {
  CI: "true",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  COREPACK_ENABLE_NETWORK: "0",
  npm_config_offline: "true",
  OPENCLAW_GATEWAY_PROJECT_SHARDS: "0",
});

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const files = cases.map(({ file }) => file).sort();

for (const [dir, sha] of [[head, HEAD], [base, BASE]]) {
  assert.equal(git(dir, "rev-parse", "HEAD"), sha, `Wrong revision in ${dir}`);
  assert.equal(
    git(dir, "status", "--porcelain=v1", "--untracked-files=no"),
    "",
    `Tracked files already modified in ${dir}`,
  );
}

for (const spec of cases) {
  for (const file of spec.sources) {
    const before = git(base, "rev-parse", `HEAD:${file}`);
    const after = git(head, "rev-parse", `HEAD:${file}`);
    assert.notEqual(before, after, `Identical implementation blobs: ${file}`);
    assert(
      !readFileSync(path.join(base, file)).equals(readFileSync(path.join(head, file))),
      `Identical implementation files on disk: ${file}`,
    );
    console.log(`${file}: ${before} -> ${after}`);
  }
}

// At the pinned SHAs, each test-file diff is exactly one added regression.
for (const file of files) copyFileSync(path.join(head, file), path.join(base, file));
assert.deepEqual(
  git(base, "diff", "--name-only", "HEAD", "--").split("\n").sort(),
  files,
  "Only the two regression test files may differ from base HEAD",
);

function runCase(spec, side, cwd) {
  const label = `${spec.id}-${side}`;
  const reportPath = path.join(out, `${label}.json`);
  const logPath = path.join(out, `${label}.log`);
  const red = side === "base";

  // Same config, file, name filter, and options on both trees.
  // Only cwd and the report destination change.
  const args = [
    "scripts/run-vitest.mjs", "run", "--config", spec.config, spec.file,
    "-t", `(?:^| )${escapeRegex(spec.title)}$`,
    "--maxWorkers=1", "--reporter=default", "--reporter=json",
    "--outputFile", reportPath,
  ];
  const run = spawnSync(process.execPath, args, {
    cwd, env, encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  writeFileSync(logPath, log);
  assert(!run.error && !run.signal, `${label}: runner did not finish; see ${logPath}`);
  assert.equal(run.status, red ? 1 : 0, `${label}: unexpected exit; see ${logPath}`);
  assert(
    !/Unhandled Errors|Vitest caught [1-9]\d* unhandled errors?/i.test(
      stripVTControlCharacters(log),
    ),
    `${label}: unhandled runtime error; see ${logPath}`,
  );

  // A missing or malformed report, collection error, or zero matches fails the lane.
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.testResults.length, 1, `${label}: expected one test file`);
  const [suite] = report.testResults;
  assert.equal(path.resolve(cwd, suite.name), path.join(cwd, spec.file), label);
  assert.equal(suite.message, "", `${label}: file-level error: ${suite.message}`);

  const matches = suite.assertionResults.filter(({ title }) => title === spec.title);
  const executed = suite.assertionResults.filter(({ status }) =>
    status === "passed" || status === "failed",
  );
  assert.equal(matches.length, 1, `${label}: expected exactly one named test`);
  assert.deepEqual(executed, matches, `${label}: named test did not run alone`);
  const [test] = matches;
  assert.equal(test.status, red ? "failed" : "passed", label);
  assert.equal(report.success, !red, label);
  assert.equal(report.numFailedTests, red ? 1 : 0, label);
  assert.equal(report.numPassedTests, red ? 0 : 1, label);

  const failures = test.failureMessages ?? [];
  assert.equal(failures.length, red ? 1 : 0, label);
  if (red) {
    const failure = stripVTControlCharacters(failures[0]);
    const frame = new RegExp(
      `^\\s*at [^\\n]*${escapeRegex(spec.file)}:${spec.line}:\\d+(?=[)\\s]|$)`,
      "m",
    );
    assert.match(failure, spec.failure, `${label}: wrong assertion failure`);
    assert.match(failure, frame, `${label}: wrong assertion line`);
  }
  console.log(`${label}: ${red ? "RED at the expected assertion" : "GREEN"}`);
}

const failures = [];
for (const spec of cases) {
  for (const [side, cwd] of [["base", base], ["head", head]]) {
    try {
      runCase(spec, side, cwd);
    } catch (error) {
      failures.push(`${spec.id}-${side}: ${error.message}`);
    }
  }
}
assert.equal(failures.length, 0, `${failures.join("\n")}\nArtifacts: ${out}`);
