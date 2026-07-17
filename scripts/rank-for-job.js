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
const { parseTask } = require('../lib/taskParser');

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
 *   title:  Rank quotes for logo job
 *   budget: 0.01 USDT
 *
 * NOTE: that `budget` is the escrow amount for OUR ranking service — the fee the
 * buyer pays us. It is NOT the buyer's budget for the providers we are ranking.
 * Scoring against it is nonsense: on job 0x4d8458 it meant every real logo
 * provider was marked "over budget" against our own 0.01 USDT fee, and an
 * escrow-monitoring service won a logo job. The buyer's real budget and
 * requirements live in the task description, which `agent status` does not
 * return — only `next-action` does, and only the AI runtime holding the event
 * payload can call that. So the description is passed in via --task-desc.
 */
async function readJob(jobId) {
  const out = await onchainos(['agent', 'status', jobId, '--agent-id', ASP_AGENT_ID]);
  const status = (out.match(/status:\s*(\w+)/i) || [])[1] || null;
  const title = (out.match(/title:\s*(.+)/i) || [])[1]?.trim() || null;
  const fee = (out.match(/budget:\s*([\d.]+)/i) || [])[1] || '0';
  return { status, title, ourFeeUsdt: Number(fee) };
}

function argValue(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : null;
}

async function main() {
  const args = process.argv.slice(2);
  const jobId = args.find((a) => a.startsWith('0x') && a.length > 40);
  const doDeliver = args.includes('--deliver');
  const taskDesc = argValue(args, '--task-desc');

  if (!jobId) {
    console.error(
      'Usage: node scripts/rank-for-job.js <jobId> --task-desc "<buyer request>" [--deliver]'
    );
    process.exit(2);
  }

  // Required, and deliberately has no fallback. The tempting default — the
  // on-chain budget — is our own service fee, which silently produces a
  // confidently wrong ranking (see readJob). Refusing is the safe failure.
  if (!taskDesc || !taskDesc.trim()) {
    console.error(
      '[rank-for-job] Refusing to run: --task-desc is required.\n' +
        '  Pass the buyer\'s request VERBATIM, exactly as it appears in the\n' +
        '  `description:` field of the next-action playbook output. It carries their\n' +
        '  real budget and deadline. Do NOT summarise it, and do NOT substitute the\n' +
        '  on-chain budget — that is our ranking fee, not the buyer\'s budget for the\n' +
        '  providers being ranked.'
    );
    process.exit(1);
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

  // The buyer wrote free text ("My budget is around 40 USDT, within 48 hours").
  // Run it through the same Groq parser the web app uses, so the budget and
  // deadline come from what they actually said rather than from our fee.
  const parsed = await parseTask(taskDesc);

  // The parser guesses a budget when the user didn't give one. That's right for
  // the web app (the user is there to correct it) and wrong here: nobody reviews
  // this before it goes on-chain. If the runtime summarised the buyer's request
  // and dropped "around 40 USDT", a guessed budget would silently drive the whole
  // ranking and look authoritative. Refuse instead.
  if (!parsed.budget_stated) {
    console.error(
      '[rank-for-job] Refusing to run: no budget found in the buyer\'s request.\n' +
        `  Parsed budget ${parsed.budget_usdt} USDT is this engine's GUESS, not their words.\n` +
        '  Usually this means --task-desc was summarised instead of copied verbatim —\n' +
        '  pass the buyer\'s full request exactly as written. If they genuinely never\n' +
        '  stated a budget, ask them via `onchainos agent user-notify` rather than\n' +
        '  ranking against an invented number.'
    );
    process.exit(1);
  }

  const task = taskFromJob({
    title: parsed.title,
    description: parsed.description,
    budgetUsdt: parsed.budget_usdt,
    deadlineHours: parsed.deadline_hours,
  });

  console.error(
    `[rank-for-job] buyer budget ${task.budget_usdt} USDT / ${task.deadline_hours}h ` +
      `(our fee for this job: ${job.ourFeeUsdt} USDT)`
  );

  const { markdown, ranked, candidateCount, inScopeCount } = await buildDeliverable(task);

  // Print the deliverable so the caller (AI runtime or a human) can use it.
  process.stdout.write(markdown + '\n');

  console.error(
    `[rank-for-job] ${candidateCount} provider(s) discovered, ${inScopeCount} able to do this task.`
  );

  if (!doDeliver) {
    console.error('[rank-for-job] Not delivered (no --deliver).');
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
