/**
 * stuckJobRecovery.test.js
 * Pure-function + injected-dependency tests for lib/stuckJobRecovery.js.
 * No network, no real onchainos calls, no shared ledger file — every test
 * uses its own temp ledger path so runs can't interfere with each other or
 * with the real ~/.okx-agent-task/apply-ledger.json.
 *
 *   node --test test/
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  findFailedDispatchJobIds,
  parseApplyCommand,
  recoverStuckJobs,
  loadLedger,
} = require('../lib/stuckJobRecovery');

function tempLedgerPath() {
  return path.join(os.tmpdir(), `apply-ledger-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('findFailedDispatchJobIds resolves the real two-line claude OAuth failure (0xd30a22, 2026-07-17)', () => {
  // For claude, the death reason and the full id never land on the SAME
  // line: the "AI session done" summary carries the reason but truncates the
  // id (0xd30a22…1eda39); the "command failed ... CLI exited" wrapper carries
  // the full id but truncates the reason away as a raw JSON dump. An earlier
  // version of this function required both on one line and matched neither —
  // this is the exact failure that let job 0xd30a22 go undetected.
  const fullId = '0xd30a2249121b70b15c42932c3de0bcfaabeb9294901990c51f1fec4b0a1eda39';
  const lines = [
    `[07/17/2026, 16:02:32.408] [okx-agent-task] direct communication session prepared session=job:${fullId}:my:4814:to:1757 job=0xd30a22…1eda39 myAgent=4814 toAgent=1757`,
    '[07/17/2026, 16:02:38.271] [okx-agent-task] AI session done session=job:0xd30a22…1eda39:my:4814:to:1757 job=0xd30a22…1eda39 my=4814 to=1757 provider=claude exitCode=1 result=stdout="Failed to authenticate: OAuth session expired and could not be refreshed"',
    `[07/17/2026, 16:02:38.288] [okx-agent-task] ai-dispatch/session-message command failed id=5d208b3b: claude CLI exited with code 1 for session=job:${fullId}:my:4814:to:1757; stdout={"type":"system","subtype":"init"...`,
  ].join('\n');
  assert.deepEqual(findFailedDispatchJobIds(lines), [fullId]);
});

test('findFailedDispatchJobIds finds nothing when the full id never appears anywhere in the log', () => {
  // No line elsewhere carries the full id, so the truncated form on the
  // failure line cannot be resolved — must not guess or fabricate an id.
  const line =
    '[07/17/2026] [okx-agent-task] AI session done session=job:0xaaaaaa…bbbbbb:my:4814:to:1757 ' +
    'provider=claude exitCode=1 result=stdout="Failed to authenticate: OAuth session expired"';
  assert.deepEqual(findFailedDispatchJobIds(line), []);
});

test('findFailedDispatchJobIds ignores task-level failures (no dead-provider signature)', () => {
  const line =
    'ai-dispatch/session-message command failed id=abc: claude CLI exited with code 1 for ' +
    'session=job:0x1111111111111111111111111111111111111111111111111111111111111111:my:4814:to:1757; ' +
    'stdout="the ranking script threw a task-level error, nothing to do with the provider"';
  assert.deepEqual(findFailedDispatchJobIds(line), []);
});

test('findFailedDispatchJobIds dedupes repeated failures on the same job', () => {
  const one =
    'ai-dispatch/session-message command failed id=a: claude CLI exited with code 1 for ' +
    'session=job:0x2222222222222222222222222222222222222222222222222222222222222222:my:4814:to:1757; ' +
    'stdout="rate limit exceeded"';
  const two = one.replace('id=a', 'id=b');
  assert.deepEqual(
    findFailedDispatchJobIds([one, two].join('\n')),
    ['0x2222222222222222222222222222222222222222222222222222222222222222']
  );
});

test('parseApplyCommand extracts jobId/agentId/amount/symbol from a real next-action block', () => {
  const nextAction = `
  Recommended action:  Apply at offer amount.
  Apply currency:      USDT (User Agent's specified token)

**APPLY path** — run apply, then branch by exit code:
\`\`\`bash
onchainos agent apply 0xd30a2249121b70b15c42932c3de0bcfaabeb9294901990c51f1fec4b0a1eda39 --agent-id 4814 --token-amount 0.01 --token-symbol USDT
\`\`\`
`;
  const parsed = parseApplyCommand(nextAction);
  assert.deepEqual(parsed, {
    jobId: '0xd30a2249121b70b15c42932c3de0bcfaabeb9294901990c51f1fec4b0a1eda39',
    agentId: '4814',
    tokenAmount: '0.01',
    tokenSymbol: 'USDT',
  });
});

test('parseApplyCommand returns null when next-action recommends reject, not apply', () => {
  const nextAction = `
  Recommended action:  none — capability mismatch.

**REJECT path** — run in order, then end the turn:
\`\`\`bash
onchainos agent asp-reject 0xabc --agent-id 4814 --reason "capability mismatch"
\`\`\`
`;
  assert.equal(parseApplyCommand(nextAction), null);
});

test('recoverStuckJobs applies to a job that is genuinely stuck (failed dispatch + status=created)', async () => {
  const jobId = '0x3333333333333333333333333333333333333333333333333333333333333333';
  const logText =
    `ai-dispatch/session-message command failed id=x: claude CLI exited with code 1 for ` +
    `session=job:${jobId}:my:4814:to:1757; stdout="You've hit your session limit"`;
  const ledgerPath = tempLedgerPath();

  const calls = [];
  const run = async (bin, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'agent' && args[1] === 'status') return 'Task status: created\n  jobId: x';
    if (args[0] === 'agent' && args[1] === 'next-action') {
      return 'Recommended action:  Apply at offer amount.\n' +
        `onchainos agent apply ${jobId} --agent-id 4814 --token-amount 0.01 --token-symbol USDT`;
    }
    if (args[0] === 'agent' && args[1] === 'apply') return 'txHash: 0xdeadbeef';
    throw new Error(`unexpected call: ${bin} ${args.join(' ')}`);
  };

  const results = await recoverStuckJobs({ deps: { logText, run, ledgerPath } });
  assert.equal(results.length, 1);
  assert.equal(results[0].action, 'applied');
  assert.equal(results[0].txHash, '0xdeadbeef');

  const ledger = loadLedger(ledgerPath);
  assert.equal(ledger[jobId].action, 'applied');
  fs.unlinkSync(ledgerPath);
});

test('recoverStuckJobs never applies twice: a job already in the ledger is skipped', async () => {
  // This is the safety property that matters most: apply is not idempotent
  // (verified live on 2026-07-17 — two calls on the same job produced two
  // separate txHashes), so a ledger hit must short-circuit before any
  // on-chain call is made.
  const jobId = '0x4444444444444444444444444444444444444444444444444444444444444444';
  const logText =
    `ai-dispatch/session-message command failed id=x: claude CLI exited with code 1 for ` +
    `session=job:${jobId}:my:4814:to:1757; stdout="rate limit"`;
  const ledgerPath = tempLedgerPath();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify({ [jobId]: { action: 'applied', txHash: '0xalready' } }));

  let calls = 0;
  const run = async () => {
    calls += 1;
    throw new Error('must not be called — job is already in the ledger');
  };

  const results = await recoverStuckJobs({ deps: { logText, run, ledgerPath } });
  assert.equal(calls, 0);
  assert.equal(results[0].action, 'skipped');
  fs.unlinkSync(ledgerPath);
});

test('recoverStuckJobs does not touch a job that has already moved past created', async () => {
  const jobId = '0x5555555555555555555555555555555555555555555555555555555555555555';
  const logText =
    `ai-dispatch/session-message command failed id=x: claude CLI exited with code 1 for ` +
    `session=job:${jobId}:my:4814:to:1757; stdout="quota exceeded"`;
  const ledgerPath = tempLedgerPath();

  const run = async (bin, args) => {
    if (args[1] === 'status') return 'Task status: submitted';
    throw new Error(`must not reach apply/next-action for a non-created job: ${args.join(' ')}`);
  };

  const results = await recoverStuckJobs({ deps: { logText, run, ledgerPath } });
  assert.equal(results[0].action, 'skipped');
  assert.match(results[0].reason, /not stuck/);
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
});

test('recoverStuckJobs does not auto-apply when next-action recommends something else', async () => {
  const jobId = '0x6666666666666666666666666666666666666666666666666666666666666666';
  const logText =
    `ai-dispatch/session-message command failed id=x: claude CLI exited with code 1 for ` +
    `session=job:${jobId}:my:4814:to:1757; stdout="session limit"`;
  const ledgerPath = tempLedgerPath();

  const run = async (bin, args) => {
    if (args[1] === 'status') return 'Task status: created';
    if (args[1] === 'next-action') return 'Recommended action: none — capability mismatch.';
    throw new Error(`must not call apply when next-action did not recommend it: ${args.join(' ')}`);
  };

  const results = await recoverStuckJobs({ deps: { logText, run, ledgerPath } });
  assert.equal(results[0].action, 'needs-review');
  if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
});

test('dryRun reports the intended action without applying or writing the ledger', async () => {
  const jobId = '0x7777777777777777777777777777777777777777777777777777777777777777';
  const logText =
    `ai-dispatch/session-message command failed id=x: claude CLI exited with code 1 for ` +
    `session=job:${jobId}:my:4814:to:1757; stdout="usage limit"`;
  const ledgerPath = tempLedgerPath();

  const run = async (bin, args) => {
    if (args[1] === 'status') return 'Task status: created';
    if (args[1] === 'next-action') {
      return 'Recommended action:  Apply at offer amount.\n' +
        `onchainos agent apply ${jobId} --agent-id 4814 --token-amount 0.01 --token-symbol USDT`;
    }
    throw new Error(`dry run must never call apply: ${args.join(' ')}`);
  };

  const results = await recoverStuckJobs({ dryRun: true, deps: { logText, run, ledgerPath } });
  assert.equal(results[0].action, 'would-apply');
  assert.equal(fs.existsSync(ledgerPath), false, 'dry run must not create a ledger file');
});
