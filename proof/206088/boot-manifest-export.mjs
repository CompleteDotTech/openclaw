import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const checkout = process.env.PROOF_PR_DIR || process.argv[2];
const results = process.env.PROOF_RESULTS_DIR;
const expected = process.env.SHA;
if (!checkout || !results || !/^[0-9a-f]{40}$/.test(expected ?? "")) {
  throw new Error("Expected a PR checkout, PROOF_RESULTS_DIR and the workflow's full SHA.");
}

const cwd = resolve(checkout);
const manifest = "ui/config/control-ui-boot-modules.json";
const git = (...args) => execFileSync("git", args, { cwd });
const head = git("rev-parse", "HEAD").toString().trim();
if (head !== expected || git("status", "--porcelain", "--", manifest).length) {
  throw new Error("The PR head or original boot manifest does not match the run entry.");
}

console.log("Manifest source: " + head + " tree=" + git("rev-parse", "HEAD^{tree}").toString().trim());
execFileSync("pnpm", ["run", "ui:boot-manifest:gen"], { cwd, stdio: "inherit" });

const generated = readFileSync(join(cwd, manifest));
JSON.parse(generated.toString("utf8"));
mkdirSync(results, { recursive: true });
writeFileSync(join(results, "boot-manifest.txt"), generated);
console.log("Manifest SHA-256: " + createHash("sha256").update(generated).digest("hex"));

const diff = git("--no-pager", "diff", "--no-color", "--no-ext-diff", "HEAD", "--", manifest);
if (diff.length) {
  console.log("--- BEGIN MANIFEST DIFF ---");
  process.stdout.write(diff);
  console.log("--- END MANIFEST DIFF ---");
} else {
  console.log("Manifest unchanged.");
}
