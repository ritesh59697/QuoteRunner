/**
 * stuckJobRecovery.js
 * Recovers jobs the daemon dropped after a provider failover.
 *
 * providerFallback.js detects a dead AI provider and rebinds the daemon to a
 * working one — but "repairing a job binding" only points that job at the new
 * provider for its NEXT dispatched event. `job_asp_selected` fires exactly
 * once per job. If that one dispatch died mid-provider-failure (as it did for
 * job 0xd30a22 on 2026-07-17: claude's OAuth expired 6 seconds in), no second
 * event ever arrives, the binding repair is never exercised, and the job sits
 * at `created` forever — invisible until the buyer checks by hand. That is
 * exactly what job 0xe51506 and 0x82d5e8 did on 2026-07-16, and what David
 * Shui's retest hit again on 2026-07-17.
 *
 * This module finds jobs with that exact signature (a past dispatch that died
 * with a provider-level failure, still sitting at `created`) and re-runs the
 * one step that never got a second chance: apply.
 *
 * Ledger, not on-chain state, is the source of truth for "did we already try":
 * `onchainos agent apply` is NOT idempotent (verified 2026-07-17 — calling it
 * twice on the same job produced two separate txHashes), and neither `agent
 * status` nor `agent common context` exposes an applicant list to check
 * against. So every attempt is recorded in a local ledger BEFORE the apply
 * call runs, not after — if the process dies mid-call, the next sweep sees
 * the ledger entry and skips the job rather than risking a second apply. That
 * trades a small chance of a job sitting unrecovered (safe: a human can clear
 * the ledger entry to re-arm it) against the alternative of silently
 * duplicating an on-chain commitment (not safe, and not reversible).
 *
 * Deliberately narrow: only jobs with a RECORDED provider-level dispatch
 * failure are touched. A job sitting at `created` with no failure record is
 * either brand new (not stuck yet) or was never dispatched at all — a
 * different problem (the invite never reached the daemon), which this module
 * must not paper over by apply-ing to jobs it has no evidence are actually stuck.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const { isProviderFailureLine } = require('./providerFallback');

const ONCHAINOS_BIN = process.env.ONCHAINOS_BIN || 'onchainos';
const ASP_AGENT_ID = process.env.OKX_ASP_AGENT_ID || '4814';

const DEFAULT_LEDGER_PATH =
  process.env.OKX_APPLY_LEDGER_PATH ||
  path.join(os.homedir(), '.okx-agent-task', 'apply-ledger.json');

const DEFAULT_LOG_PATH = path.join(os.homedir(), '.okx-agent-task', 'logs', 'listener.log');

function loadLedger(ledgerPath = DEFAULT_LEDGER_PATH) {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveLedger(ledger, ledgerPath = DEFAULT_LEDGER_PATH) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

function recordLedger(jobId, info, ledgerPath = DEFAULT_LEDGER_PATH) {
  const ledger = loadLedger(ledgerPath);
  ledger[jobId] = { ...info, recordedAt: new Date().toISOString() };
  saveLedger(ledger, ledgerPath);
  return ledger;
}

function truncatedForm(fullId) {
  const hex = fullId.slice(2);
  return `0x${hex.slice(0, 6)}…${hex.slice(-6)}`;
}

/**
 * Map every truncated display id (0xd30a22…1eda39) seen in the log to the
 * full id it was truncated from, by scanning for full ids anywhere in the
 * text — not just on failure lines. The full id reliably shows up elsewhere
 * for the same job (e.g. "direct communication session prepared
 * session=job:<FULL>:my:...") even when the failure line itself only carries
 * the truncated form.
 */
function buildTruncationMap(text) {
  const map = new Map();
  const re = /\b(0x[0-9a-fA-F]{40,})\b/g;
  let m;
  while ((m = re.exec(text))) {
    map.set(truncatedForm(m[1]), m[1]);
  }
  return map;
}

/**
 * Extract full jobIds from listener.log text whose dispatch died with a
 * provider-level signature (reuses providerFallback's detector so this and
 * the watchdog never disagree on what "dead" looks like).
 *
 * The daemon logs a dead dispatch in two line shapes, and which one carries
 * the death-reason text is NOT the same shape that carries the full id:
 *
 *   A. "AI session done ... provider=claude exitCode=1 ... result=stdout=
 *       \"Failed to authenticate: OAuth session expired\""
 *      — has the reason, but the id is ellipsis-truncated (0xd30a22…1eda39)
 *   B. "ai-dispatch/... command failed ...: claude CLI exited with code 1
 *       ...session=job:<FULL_ID>:my:...; stdout={\"type\":\"system\",...}"
 *      — has the full id, but for claude the reason is cut off mid-JSON
 *
 * Matching only shape B (as an earlier version of this function did) misses
 * every claude outage: shape B's stdout dump doesn't contain the death phrase,
 * so `isProviderFailureLine` never fires on it, and shape A's truncated id is
 * useless for a status/apply call. This is exactly how job 0xd30a22's own
 * failure went undetected when this function was first written and tested
 * only against a single-line fixture.
 *
 * The fix: read the reason off whichever line shape has it, then resolve a
 * truncated id to its full form via the map built above.
 */
function findFailedDispatchJobIds(logText) {
  const text = String(logText || '');
  const truncMap = buildTruncationMap(text);
  const ids = new Set();
  const lines = text.split('\n');
  for (const line of lines) {
    if (!isProviderFailureLine(line)) continue;

    const fullMatch = line.match(/\b(0x[0-9a-fA-F]{40,})\b/);
    if (fullMatch) {
      ids.add(fullMatch[1]);
      continue;
    }

    const truncMatch = line.match(/\b(0x[0-9a-fA-F]{4,8})…([0-9a-fA-F]{4,8})\b/);
    if (truncMatch) {
      const full = truncMap.get(`${truncMatch[1]}…${truncMatch[2]}`);
      if (full) ids.add(full);
    }
  }
  return [...ids];
}

/**
 * Pull the `onchainos agent apply ...` command straight out of next-action's
 * own recommendation, rather than reimplementing the fee/currency/eligibility
 * logic it already encodes (amount varies per job — 0x82d5e8 offered 1 USDT,
 * most others 0.01).
 *
 * Returns null when the playbook did not recommend APPLY (capability
 * mismatch, already-handled, ineligible, etc). Callers must treat null as
 * "do not act" — never fall back to guessing an amount.
 */
function parseApplyCommand(nextActionOutput) {
  const text = String(nextActionOutput || '');
  if (!/Recommended action:\s*Apply/i.test(text)) return null;
  const m = text.match(
    /onchainos agent apply (0x[0-9a-fA-F]+) --agent-id (\S+) --token-amount (\S+) --token-symbol (\S+)/
  );
  if (!m) return null;
  return { jobId: m[1], agentId: m[2], tokenAmount: m[3], tokenSymbol: m[4] };
}

async function defaultRun(bin, args) {
  const { stdout } = await execFileAsync(bin, args, {
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });
  return stdout || '';
}

/**
 * Find + recover jobs that are provably stuck, and report what happened to
 * every candidate (not just the ones it acted on) so a sweep is auditable.
 *
 * @param {object} opts
 * @param {boolean} opts.dryRun - report what would happen without applying or
 *        writing the ledger.
 * @param {object} opts.deps - injectable for testing:
 *        { logText, run(bin, args), ledgerPath }. Production defaults read
 *        the real listener.log and shell out to onchainos.
 * @returns {Promise<Array>} one entry per candidate jobId:
 *        { jobId, action: 'applied'|'skipped'|'would-apply'|'needs-review'|'error', ... }
 */
async function recoverStuckJobs({ dryRun = false, deps = {} } = {}) {
  const logText =
    deps.logText !== undefined ? deps.logText : fs.readFileSync(DEFAULT_LOG_PATH, 'utf8');
  const run = deps.run || defaultRun;
  const ledgerPath = deps.ledgerPath || DEFAULT_LEDGER_PATH;

  const failedJobIds = findFailedDispatchJobIds(logText);
  const results = [];

  for (const jobId of failedJobIds) {
    const ledger = loadLedger(ledgerPath);
    if (ledger[jobId]) {
      results.push({ jobId, action: 'skipped', reason: `already recorded: ${ledger[jobId].action}` });
      continue;
    }

    let statusOut;
    try {
      statusOut = await run(ONCHAINOS_BIN, ['agent', 'status', jobId, '--agent-id', ASP_AGENT_ID]);
    } catch (err) {
      results.push({ jobId, action: 'error', reason: `status check failed: ${err.message}` });
      continue;
    }
    const status = (statusOut.match(/status:\s*(\w+)/i) || [])[1] || null;
    if (status !== 'created') {
      // Already moved on (applied through a later retry, expired, whatever) —
      // nothing to recover.
      results.push({ jobId, action: 'skipped', reason: `status is "${status}", not stuck` });
      continue;
    }

    let nextActionOut;
    try {
      nextActionOut = await run(ONCHAINOS_BIN, [
        'agent',
        'next-action',
        '--role',
        'asp',
        '--agentId',
        ASP_AGENT_ID,
        '--message',
        JSON.stringify({ event: 'job_asp_selected', jobId }),
      ]);
    } catch (err) {
      results.push({ jobId, action: 'error', reason: `next-action failed: ${err.message}` });
      continue;
    }

    const applyCmd = parseApplyCommand(nextActionOut);
    if (!applyCmd) {
      // Might be a reject case, might be something the playbook wants an LLM
      // capability judgment for — either way, not a decision this sweep makes.
      results.push({
        jobId,
        action: 'needs-review',
        reason: 'next-action did not recommend Apply — needs a human or an LLM judgment call, not auto-applied',
      });
      continue;
    }

    if (dryRun) {
      results.push({ jobId, action: 'would-apply', ...applyCmd });
      continue;
    }

    // Record BEFORE calling apply, not after: apply is not idempotent, so a
    // crash between a successful apply and recording it would let the next
    // sweep apply again. Recording early means the worst case is a job that
    // needs a human to clear its ledger entry, not a duplicate on-chain bid.
    recordLedger(jobId, { action: 'applying', ...applyCmd }, ledgerPath);

    try {
      const applyOut = await run(ONCHAINOS_BIN, [
        'agent',
        'apply',
        applyCmd.jobId,
        '--agent-id',
        applyCmd.agentId,
        '--token-amount',
        applyCmd.tokenAmount,
        '--token-symbol',
        applyCmd.tokenSymbol,
      ]);
      const txHash = (applyOut.match(/txHash:\s*(\S+)/i) || [])[1] || null;
      recordLedger(jobId, { action: 'applied', txHash, ...applyCmd }, ledgerPath);
      results.push({ jobId, action: 'applied', txHash });
    } catch (err) {
      recordLedger(jobId, { action: 'apply-failed', reason: err.message, ...applyCmd }, ledgerPath);
      results.push({ jobId, action: 'error', reason: `apply failed: ${err.message}` });
    }
  }

  return results;
}

module.exports = {
  DEFAULT_LEDGER_PATH,
  loadLedger,
  saveLedger,
  recordLedger,
  findFailedDispatchJobIds,
  parseApplyCommand,
  recoverStuckJobs,
};
