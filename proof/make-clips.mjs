#!/usr/bin/env node
// Builds scripted WAV clips for a scenario with OpenAI text-to-speech: one clip
// per case, or one per case and take when the scenario lists takes.
//
// Usage:  node proof/make-clips.mjs <scenario.json> [out-dir] [--dry-run]
//         out-dir defaults to clips/ next to scenario.json.
// Env:    OPENAI_API_KEY (not needed with --dry-run, which writes silent clips
//         of estimated length so the scenario can be checked without the key).
//
// Scenario shape (extra fields such as expectedTranscript are kept as-is):
// {
//   "leadingSilenceMs": 500,
//   "tts": { "model": "gpt-4o-mini-tts", "voice": "alloy", "instructions": "..." },
//   "takes": [                                   // optional
//     { "id": "alloy-steady", "voice": "alloy", "instructions": "..." }
//   ],
//   "cases": [
//     { "id": "contractions",
//       "segments": [ { "text": "Let's inspect", "pauseAfterMs": 120 },
//                     { "text": "because it's failing.", "pauseAfterMs": 1400 } ] }
//   ]
// }
// Each clip is: leading silence, then every segment's speech followed by exactly
// pauseAfterMs of silence (the last segment's pause is the trailing silence).
// Voice and instructions come from the segment, then the take, then "tts".
// Output: <out-dir>/<case id>.wav, or <out-dir>/<case id>--<take id>.wav for
// every case and take when takes are given, as 48 kHz mono 16-bit PCM, plus
// manifest.json and script.md describing what every clip says.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TTS_RATE = 24000; // OpenAI "pcm" output: 24 kHz, 16-bit signed little-endian, mono
const OUT_RATE = 48000; // what the browser harnesses expect
const ENDPOINT = "https://api.openai.com/v1/audio/speech";
const DEFAULT_INSTRUCTIONS =
  "Speak clearly at a natural dictation pace in American English. " +
  "Express punctuation and quotation marks through intonation only; never say punctuation names aloud.";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const [scenarioPath, outArg] = args.filter((a) => !a.startsWith("--"));
if (!scenarioPath) {
  console.error("usage: node make-clips.mjs <scenario.json> [out-dir] [--dry-run]");
  process.exit(2);
}
const outDir = outArg || path.join(path.dirname(scenarioPath), "clips");

let scenario;
try {
  scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
  validate(scenario);
} catch (err) {
  console.error(`Scenario rejected: ${err.message}`);
  process.exit(2);
}
const tts = { model: "gpt-4o-mini-tts", voice: "alloy", instructions: DEFAULT_INSTRUCTIONS, ...(scenario.tts || {}) };
const leadMs = scenario.leadingSilenceMs ?? 500;
const takes = scenario.takes?.length ? scenario.takes : [null];

const key = process.env.OPENAI_API_KEY?.trim();
if (!dryRun && !key) {
  console.error("OPENAI_API_KEY is not set (use --dry-run to check the scenario without it).");
  process.exit(2);
}

await mkdir(outDir, { recursive: true });
const cache = new Map();
const clips = [];
const script = [
  "# Scripted audio clips",
  "",
  dryRun
    ? "Dry run: silent placeholder clips, no speech was generated."
    : `Speech: ${tts.model}${takes[0] ? "" : `, voice ${tts.voice}`}. Clips are 48 kHz mono 16-bit PCM WAV.`,
  "",
];
if (takes[0]) {
  script.push("Takes (every case is recorded once per take):", "");
  for (const t of takes) script.push(`- ${t.id}: voice ${t.voice || tts.voice}; instructions: ${t.instructions ?? tts.instructions}`);
  script.push("");
}

for (const c of scenario.cases) {
  for (const take of takes) {
    const id = take ? `${c.id}--${take.id}` : c.id;
    const parts = [silence(leadMs, TTS_RATE)];
    const said = [`[${leadMs} ms silence]`];
    const voices = new Set();
    for (const seg of c.segments) {
      const voice = seg.voice || take?.voice || tts.voice;
      const instructions = seg.instructions ?? take?.instructions ?? tts.instructions;
      voices.add(voice);
      parts.push(dryRun ? silence(estimateMs(seg.text), TTS_RATE) : await speak(seg.text, voice, instructions));
      parts.push(silence(seg.pauseAfterMs, TTS_RATE));
      said.push(`"${seg.text}"`, `[${seg.pauseAfterMs} ms silence]`);
    }
    const pcm = upsample2x(Buffer.concat(parts));
    const wav = Buffer.concat([wavHeader(pcm.length, OUT_RATE), pcm]);
    const file = path.join(outDir, `${id}.wav`);
    await writeFile(file, wav);
    const durationMs = Math.round((pcm.length / 2 / OUT_RATE) * 1000);
    clips.push({
      id, case: c.id, ...(take ? { take: take.id } : {}), voice: [...voices].join(", "),
      file: path.basename(file), duration_ms: durationMs, sha256: createHash("sha256").update(wav).digest("hex"),
    });
    script.push(`## ${id}`, "");
    if (take) script.push(`Take: ${take.id} (voice ${[...voices].join(", ")})`, "");
    script.push(`Plays: ${said.join(" ")}`, "", `Length: ${(durationMs / 1000).toFixed(2)} s`, "");
    for (const k of ["expectedTranscript", "expectedComposer"]) if (c[k]) script.push(`${k}: ${c[k]}`, "");
    console.log(`${dryRun ? "[dry-run] " : ""}${file}  ${(durationMs / 1000).toFixed(2)} s`);
  }
}

const manifestTakes = takes[0] ? { takes: takes.map((t) => ({ id: t.id, voice: t.voice || tts.voice, instructions: t.instructions ?? tts.instructions })) } : {};
await writeFile(path.join(outDir, "manifest.json"), JSON.stringify({ tts: { model: tts.model, voice: tts.voice }, ...manifestTakes, dry_run: dryRun, leading_silence_ms: leadMs, clips }, null, 2) + "\n");
await writeFile(path.join(outDir, "script.md"), script.join("\n"));
console.log(`Wrote ${clips.length} clip(s), manifest.json and script.md to ${outDir}`);

function validate(s) {
  if (!s || !Array.isArray(s.cases) || s.cases.length === 0) throw new Error("cases must be a non-empty array");
  if (s.leadingSilenceMs !== undefined && !(Number.isInteger(s.leadingSilenceMs) && s.leadingSilenceMs >= 0 && s.leadingSilenceMs <= 30000)) {
    throw new Error("leadingSilenceMs must be an integer from 0 to 30000");
  }
  if (s.takes !== undefined) {
    if (!Array.isArray(s.takes)) throw new Error("takes must be an array");
    const takeIds = new Set();
    for (const t of s.takes) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t?.id || "")) throw new Error(`bad take id: ${JSON.stringify(t?.id)}`);
      if (takeIds.has(t.id)) throw new Error(`duplicate take id: ${t.id}`);
      takeIds.add(t.id);
      if (t.voice !== undefined && (typeof t.voice !== "string" || !t.voice.trim())) throw new Error(`${t.id}: voice must be a non-empty string`);
      if (t.instructions !== undefined && (typeof t.instructions !== "string" || t.instructions.length > 4000)) throw new Error(`${t.id}: instructions must be a string of at most 4000 chars`);
    }
  }
  const ids = new Set();
  for (const c of s.cases) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.id || "")) throw new Error(`bad case id: ${JSON.stringify(c.id)}`);
    if (ids.has(c.id)) throw new Error(`duplicate case id: ${c.id}`);
    ids.add(c.id);
    if (!Array.isArray(c.segments) || c.segments.length === 0) throw new Error(`${c.id}: segments must be a non-empty array`);
    for (const seg of c.segments) {
      if (typeof seg.text !== "string" || !seg.text.trim() || seg.text.length > 4000) throw new Error(`${c.id}: every segment needs text (1-4000 chars)`);
      if (!(Number.isInteger(seg.pauseAfterMs) && seg.pauseAfterMs >= 0 && seg.pauseAfterMs <= 30000)) throw new Error(`${c.id}: pauseAfterMs must be an integer from 0 to 30000`);
    }
  }
}

async function speak(text, voice, instructions) {
  const cacheKey = JSON.stringify([tts.model, voice, instructions ?? "", text]);
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const body = { model: tts.model, voice, input: text, response_format: "pcm" };
  if (instructions) body.instructions = instructions;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const pcm = Buffer.from(await res.arrayBuffer());
      if (pcm.length === 0 || pcm.length % 2 !== 0) throw new Error(`unexpected PCM length for ${JSON.stringify(text)}`);
      cache.set(cacheKey, pcm);
      return pcm;
    }
    const detail = (await res.text()).replaceAll(key, "[redacted]").slice(0, 300);
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = 1000 * 2 ** attempt;
      console.warn(`TTS ${res.status}, retrying in ${wait} ms: ${detail}`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`TTS request failed (${res.status}) for ${JSON.stringify(text)}: ${detail}`);
  }
}

function silence(ms, rate) {
  return Buffer.alloc(Math.round((rate * ms) / 1000) * 2);
}

function estimateMs(text) {
  return Math.max(400, text.trim().split(/\s+/).length * 380);
}

// 24 kHz -> 48 kHz by linear interpolation between neighbouring samples.
function upsample2x(pcm) {
  const n = pcm.length / 2;
  const out = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < n; i++) {
    const a = pcm.readInt16LE(i * 2);
    const b = i + 1 < n ? pcm.readInt16LE((i + 1) * 2) : a;
    out.writeInt16LE(a, i * 4);
    out.writeInt16LE(Math.round((a + b) / 2), i * 4 + 2);
  }
  return out;
}

function wavHeader(dataBytes, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); // byte rate
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}
