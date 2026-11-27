import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const pr = process.env.PROOF_PR_DIR || process.argv[2];
const base = JSON.parse(process.env.PROOF_CHECKOUTS || "{}")["parser-base"];
const results = process.env.PROOF_RESULTS_DIR;
assert(pr && base && results, "Expected PR, parser-base and results directories");
const out = join(results, "parser-red-green");
await mkdir(out, { recursive: true });
const parserBase = "b92136b4e18178281804b91b8ca060db1ade2907";
const parser = "ui/src/lib/dictation-file-references.ts";
const test = "ui/src/lib/dictation-file-references.test.ts";
const name = "retains surrounding contractions and distinct command ranges";
const summary = { status: "FAIL", parserBase, test: name, observations: [] };

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, "Git command failed: " + args[0]);
  return r.stdout.trim();
}

async function run(cwd, label, expected) {
  const report = join(out, label + ".vitest.json");
  const r = spawnSync("pnpm", ["test", test, "--maxWorkers=1", "-t", name,
    "--reporter=json", "--outputFile=" + report], {
    cwd, encoding: "utf8", timeout: 180_000, maxBuffer: 2 ** 20,
  });
  assert(!r.error && r.signal === null, label + ": test runner did not complete");
  const data = JSON.parse(await readFile(report, "utf8"));
  const assertions = data.testResults.flatMap((suite) => suite.assertionResults || []);
  const ran = assertions.filter((item) => item.status === "passed" || item.status === "failed");
  assert.equal(ran.length, 1, label + ": expected exactly one collected and executed assertion");
  const [result] = ran;
  assert.equal(result.title, name);
  assert.equal(result.status, expected);
  assert.equal(r.status, expected === "failed" ? 1 : 0);
  if (expected === "failed") {
    const messages = result.failureMessages.join(" ");
    assert(messages.includes("AssertionError") && /to deeply equal|deep equality/i.test(messages) &&
      messages.includes("Src/Auth.TS") && messages.includes("résumé.md"),
    "Expected the missing first reference assertion, not a setup/collection failure");
  }
  summary.observations.push({ label, head: git(cwd, "rev-parse", "HEAD"),
    parserBlob: git(cwd, "hash-object", parser), status: result.status });
}

let original;
try {
  assert.notEqual(pr, base);
  assert.equal(git(base, "rev-parse", "HEAD"), parserBase);
  assert.equal(git(base, "status", "--porcelain", "--untracked-files=no"), "");
  const baseParser = git(base, "rev-parse", "HEAD:" + parser);
  const fixedTest = await readFile(join(pr, test));
  const baseTest = await readFile(join(base, test));
  assert(!fixedTest.equals(baseTest), "Expected the fixed regression to change the test file");
  original = baseTest;
  await writeFile(join(base, test), fixedTest);
  assert.equal(git(base, "diff", "--name-only"), test);
  assert.equal(git(base, "hash-object", parser), baseParser);
  await run(base, "base", "failed");
  await run(pr, "candidate", "passed");
  summary.status = "PASS";
} finally {
  if (original) await writeFile(join(base, test), original);
  await writeFile(join(out, "assertions.json"), JSON.stringify(summary, null, 2));
}
