// Round 6: observations for the author-controlled scripted proof. No candidate imports here.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);

function fixtureWindow(before, after) {
  return Object.fromEntries(['posts', 'otherPosts', 'authRejects', 'modelRejects', 'issued']
    .map(k => [k, after[k] - before[k]]));
}

// Consume the private Gateway's warning streams. Retain only a prefix of this fixed
// marker between chunks, never a log line, terminal output, path, prompt or credential.
function watchToolFilterWarning(streams) {
  const marker = 'No callable tools remain after resolving explicit tool allowlist';
  let count = 0;
  for (const stream of streams) {
    let prefix = '';
    stream.on('data', bytes => {
      const text = prefix + bytes.toString('utf8');
      if (text.includes(marker)) count++;
      let n = Math.min(marker.length - 1, text.length);
      while (n && !text.endsWith(marker.slice(0, n))) n--;
      prefix = marker.slice(0, n);
    });
  }
  return () => count;
}

// A separate seeded session, never one of the 33 audio takes. The child must be async:
// a synchronous CLI wait would block the HTTP fixture running on this Node event loop.
async function probeCompanion(checkout, env, fixture, fixtureRef, warningCount, node = process.execPath) {
  const key = 'agent:main:proof-route-' + randomBytes(6).toString('hex');
  const call = async (method, params, budget) => {
    const { stdout } = await runFile(node, ['openclaw.mjs', 'gateway', 'call', method, '--json',
      '--timeout', String(budget), '--params', JSON.stringify(params)], {
      cwd: checkout, env, timeout: budget + 10000, maxBuffer: 256 * 1024, encoding: 'utf8',
    });
    return JSON.parse(stdout);
  };
  const scope = { agentId: 'main', sessionKey: key };
  const receipt = { stage: 'seed', ok: false, routeMatches: null, rpcOK: null,
    validTimestamp: null, answerPresent: null, fixtureAnswer: null, fixtureWindow: null };
  let before, warned;
  try {
    const seed = await call('sessions.create', { agentId: 'main', key, label: 'Loopback preflight' }, 40000);
    if (seed?.ok !== true || seed.key !== key || seed.runError) return receipt;
    receipt.stage = 'read default';
    const state = await call('sessions.companion.state', scope, 40000);
    receipt.routeMatches = state?.defaultModel === fixtureRef;
    if (!receipt.routeMatches) return receipt; // Never probe a different or paid route.
    receipt.stage = 'real ask RPC';
    before = fixture.snapshot(); warned = warningCount();
    receipt.rpcOK = false;
    const reply = await call('sessions.companion.ask', { ...scope, question: 'Synthetic local route check.' }, 310000);
    receipt.rpcOK = true;
    receipt.answerPresent = typeof reply?.answer === 'string' && Boolean(reply.answer.trim());
    receipt.validTimestamp = Number.isSafeInteger(reply?.ts) && reply.ts >= 0;
    receipt.fixtureAnswer = fixture.isFreshAnswer(reply?.answer, before.issued);
    receipt.stage = 'validate receipt';
    receipt.ok = receipt.answerPresent && receipt.validTimestamp && receipt.fixtureAnswer && fixture.snapshot().posts > before.posts;
    if (receipt.ok) receipt.stage = 'complete';
  } catch (error) {
    // execFile errors include argv, stdout and stderr. Never export the thrown object.
    receipt.cliFailure = error?.killed ? 'timeout-or-signal' : Number.isInteger(error?.code) ? 'nonzero-exit' : 'invalid-or-missing-reply';
  } finally {
    if (before) {
      receipt.fixtureWindow = fixtureWindow(before, fixture.snapshot());
      receipt.emptyToolWarningObserved = warningCount() > warned;
    }
  }
  return receipt;
}

// Check both sides of the comparison before using the microphone: the scripted speech
// spells the expected words and the actual file matches the *live* clip-builder manifest.
function verifyClipBindings(clips, manifest, words) {
  assert.equal(clips.length, 33, 'expected all 11 cases x 3 voices');
  assert.equal(manifest?.dry_run, false, 'refusing dry-run audio');
  assert.equal(manifest?.clips?.length, clips.length, 'clip manifest has a different take count');
  const byId = new Map(manifest.clips.map(row => [row.id, row]));
  assert.equal(byId.size, clips.length, 'duplicate clip manifest ID');
  for (const c of clips) {
    assert.equal(words(c.segments.map(s => s.text).join(' ')), c.expect.words, c.name + ': expected words differ from TTS input');
    const row = byId.get(c.name);
    assert.ok(row && row.case === c.id && row.take === c.take && row.voice === c.voice &&
      row.file === c.name + '.wav' && row.sha256 === c.hash && row.duration_ms === Math.round(c.ms),
      c.name + ': audio file, take, voice, hash or duration did not match the manifest');
  }
}

// For public job logs, show only words from this take's fixed script. Unknown words
// stay in its scrubbed transcript.txt, not the one-line log. Never use this projection
// for qualification: substitution, omission, duplication or a late partial is still a miss.
function recognizerReceipt(s, c, words) {
  const finals = s?.finals ?? [], normalized = words(finals.join(' '));
  const expected = c.expect.words, script = new Set(expected.split(' '));
  const tokens = normalized ? normalized.split(' ') : [];
  return { expected, observedScriptTokens: tokens.slice(0, 24).map(t => script.has(t) ? t : '<other>'),
    observedWordCount: tokens.length, finalCount: finals.length, laterPartial: Boolean(s?.laterPartial),
    lexicalMatch: normalized === expected, finalAccepted: Boolean(s?.closed && s?.drained),
    clipSha256: c.hash, clipMs: Math.round(c.ms), forwardedFrames: s?.audio ?? 0, acceptedFrames: s?.audioAccepted ?? 0,
    forwardedBytes: s?.audioBytes ?? 0, forwardedSha256: s?.audioHash?.copy().digest('hex') ?? null };
}

module.exports = { fixtureWindow, watchToolFilterWarning, probeCompanion, verifyClipBindings, recognizerReceipt };
