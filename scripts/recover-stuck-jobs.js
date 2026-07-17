#!/usr/bin/env node
/**
 * recover-stuck-jobs.js — manual trigger for lib/stuckJobRecovery.js.
 *
 * The watchdog runs this automatically after every failover and on a periodic
 * timer (see scripts/provider-watchdog.js). This wrapper is for running a
 * sweep by hand — e.g. right after noticing a job is stuck, without waiting
 * for the next scheduled sweep.
 *
 * Usage:
 *   node scripts/recover-stuck-jobs.js            # apply for real
 *   node scripts/recover-stuck-jobs.js --dry-run   # report only, no on-chain action
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { recoverStuckJobs } = require('../lib/stuckJobRecovery');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const results = await recoverStuckJobs({ dryRun });

  if (results.length === 0) {
    console.log('[recover-stuck-jobs] No jobs with a recorded provider-level dispatch failure found.');
    return;
  }

  for (const r of results) {
    const extra = Object.entries(r)
      .filter(([k]) => !['jobId', 'action'].includes(k))
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(`[recover-stuck-jobs] ${r.jobId} -> ${r.action}${extra ? ' (' + extra + ')' : ''}`);
  }
}

main().catch((err) => {
  console.error('[recover-stuck-jobs] error:', err.message);
  process.exit(1);
});
