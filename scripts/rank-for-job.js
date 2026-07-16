#!/usr/bin/env node
/**
 * rank-for-job.js — produce (and optionally submit) the REAL Quote Runner
 * deliverable for an accepted job.
 *
 * Usage:
 *   node scripts/rank-for-job.js <jobId>            # print deliverable to stdout
 *   node scripts/rank-for-job.js <jobId> --deliver  # also submit it on-chain
 *
 * The daemon's ASP AI is instructed (via the workspace SKILL.md) to run this
 * for the deliver step and submit its output verbatim, so the on-chain
 * deliverable is your real ranking — not an improvised one.
 *
 * `--deliver` is gated: it refuses unless the job is in `accepted` status,
 * mirroring the protocol rule that deliver only follows job_accepted.
 */

// Resolve .env from THIS script's location, never from cwd. The daemon invokes
// us with cwd=~/.okx-agent-task/workspace, where no .env exists — a bare
// dotenv.config() silently finds nothing, MARKETPLACE_MODE falls back to
// 'mock', and this script cheerfully prints fabricated MOCK_AGENT_POOL
// providers that the AI then delivers on-chain as a real ranking.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const { buildDeliverable, taskFromJob, MODE } = require('../lib/deliverableBuilder');

const ONCHAINOS_BIN = process.env.ONCHAINOS_BIN || 'onchainos';
const ASP_AGENT_ID = process.env.OKX_ASP_AGENT_ID || '4814';

function cliEnv() {
  return {
    ...process.env,
    OKX_API_KEY: process.env.OKX_API_KEY,
    OKX_SECRET_KEY: process.env.OKX_SECRET_KEY,
    OKX_PASSPHRASE: process.env.OKX_PASSPHRASE,
  };
}

async function onchainos(args, { timeout = 90000 } = {}) {
  const { stdout } = await execFileAsync(ONCHAINOS_BIN, args, {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: cliEnv(),
  });
  return stdout || '';
}

/**
 * Read what we can about the job. `agent status` prints plain text:
 *   Task status: accepted
 *   title:  Rank agents for logo work
 *   budget: 0.01 USDT
 * The on-chain budget is authoritative — we never guess it.
 */
async function readJob(jobId) {
  const out = await onchainos(['agent', 'status', jobId, '--agent-id', ASP_AGENT_ID]);
  const status = (out.match(/status:\s*(\w+)/i) || [])[1] || null;
  const title = (out.match(/title:\s*(.+)/i) || [])[1]?.trim() || null;
  const budget = (out.match(/budget:\s*([\d.]+)/i) || [])[1] || '0';
  return { status, title, budgetUsdt: Number(budget) };
}

async function main() {
  const args = process.argv.slice(2);
  const jobId = args.find((a) => a.startsWith('0x'));
  const doDeliver = args.includes('--deliver');

  if (!jobId) {
    console.error('Usage: node scripts/rank-for-job.js <jobId> [--deliver]');
    process.exit(2);
  }

  // Hard gate, not a warning. The workspace instructions tell the AI runtime to
  // take our stdout verbatim and deliver it, so printing a mock ranking is as
  // dangerous as delivering one ourselves — the fabricated providers reach the
  // buyer either way. Exiting non-zero is the documented signal for the runtime
  // to notify the buyer instead of inventing a deliverable.
  if (MODE !== 'live') {
    console.error(
      `[rank-for-job] Refusing to run: MARKETPLACE_MODE is "${MODE}", not "live".\n` +
        `  A mock ranking must never reach an on-chain deliverable. This usually means\n` +
        `  .env was not loaded — check ${path.join(__dirname, '..', '.env')} exists and\n` +
        `  sets MARKETPLACE_MODE=live.`
    );
    process.exit(1);
  }

  const job = await readJob(jobId);
  const task = taskFromJob({
    title: job.title,
    description: job.title, // asp-match keys off text; title is the task summary
    budgetUsdt: job.budgetUsdt,
  });

  const { markdown, ranked, candidateCount } = await buildDeliverable(task);

  // Print the deliverable so the caller (AI runtime or a human) can use it.
  process.stdout.write(markdown + '\n');

  if (!doDeliver) {
    console.error(
      `\n[rank-for-job] ${candidateCount} provider(s) ranked. Not delivered (no --deliver).`
    );
    return;
  }

  if (job.status !== 'accepted') {
    console.error(
      `\n[rank-for-job] Refusing to deliver: job status is "${job.status}", expected "accepted". ` +
        `Deliver only follows job_accepted.`
    );
    process.exit(1);
  }
  if (ranked.length === 0) {
    console.error('\n[rank-for-job] Refusing to deliver an empty ranking.');
    process.exit(1);
  }

  await onchainos([
    'agent', 'deliver', jobId,
    '--agent-id', ASP_AGENT_ID,
    '--message', 'Quote Runner ranking complete — see deliverable.',
    '--deliverable-text', markdown,
  ]);
  console.error(`\n[rank-for-job] Delivered real ranking for ${jobId}.`);
}

main().catch((err) => {
  console.error('[rank-for-job] error:', err.message);
  process.exit(1);
});
