#!/usr/bin/env node
/**
 * provider-watchdog.js
 * Reactive AI-provider failover for the OKX A2A daemon.
 *
 * Tails the daemon's listener log. When a job dispatch fails with a
 * provider-level signature (expired login, exhausted quota), it runs the
 * failover in providerFallback.js: probe the priority list and re-bind the
 * daemon to the first working provider, repairing in-flight job bindings.
 *
 * Runs independently of the Express server so the ASP stays protected even
 * when the web app is down. Start with: npm run watchdog
 *
 * Env:
 *   OKX_A2A_LOG          path to listener.log (default: ~/.okx-agent-task/logs/listener.log)
 *   OKX_PROVIDER_PRIORITY comma list, default "claude,codex,hermes"
 *   OKX_A2A_BIN          okx-a2a binary path
 */

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ensureWorkingProvider,
  isProviderFailureLine,
  extractFailedProvider,
} = require('../lib/providerFallback');
const { recoverStuckJobs } = require('../lib/stuckJobRecovery');

const LOG_PATH =
  process.env.OKX_A2A_LOG ||
  path.join(os.homedir(), '.okx-agent-task', 'logs', 'listener.log');

const POLL_MS = Number(process.env.OKX_WATCHDOG_POLL_MS || 5000);
// After a failover, ignore further failures for this long so one burst of
// failed dispatches doesn't trigger repeated switches.
const COOLDOWN_MS = Number(process.env.OKX_WATCHDOG_COOLDOWN_MS || 120000);
// Independent of failover events: catches jobs stuck by a failure this
// process didn't witness (e.g. the watchdog itself was down when it happened
// — the exact gap that let 0xe51506 and 0x82d5e8 rot unnoticed).
const RECOVERY_SWEEP_MS = Number(process.env.OKX_RECOVERY_SWEEP_MS || 5 * 60 * 1000);

let lastSize = 0;
let lastFailoverAt = 0;
let running = false;

function log(...args) {
  console.log(`[watchdog ${new Date().toISOString()}]`, ...args);
}

// Failure-line detection lives in providerFallback.js so this watchdog and the
// server's readiness check agree on what a dead provider looks like.

async function onProviderFailure(suspectProvider, line) {
  const now = Date.now();
  if (now - lastFailoverAt < COOLDOWN_MS) {
    log(`suspected ${suspectProvider} failure, but within cooldown — skipping.`);
    return;
  }
  if (running) return;
  running = true;
  try {
    log(`provider failure detected (suspect=${suspectProvider}). Line: ${line.slice(0, 160)}`);
    const report = await ensureWorkingProvider({ suspectProvider });
    log(report.message || JSON.stringify(report));
    if (report.action === 'switched') {
      lastFailoverAt = Date.now();
      log(`FAILOVER complete → ${report.switchedTo}. Repaired jobs: ${report.repairedJobs.join(', ') || 'none'}`);
    }
  } catch (err) {
    log('failover error:', err.message);
  } finally {
    running = false;
  }
  // Rebinding a job's provider only takes effect on its NEXT dispatch, and
  // job_asp_selected fires exactly once — so a job whose one dispatch died
  // during this failure never gets a second chance on its own. Run every
  // time, success or not: even if the failover itself errored, any job stuck
  // from an earlier, already-completed failover is still worth sweeping.
  await runRecoverySweep('post-failover');
}

let sweepRunning = false;
async function runRecoverySweep(trigger) {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const results = await recoverStuckJobs();
    for (const r of results) {
      if (r.action === 'skipped') continue; // routine — not worth a log line
      log(`recovery (${trigger}) job=${r.jobId} action=${r.action}` + (r.reason ? ` reason=${r.reason}` : '') + (r.txHash ? ` tx=${r.txHash}` : ''));
    }
  } catch (err) {
    log('recovery sweep error:', err.message);
  } finally {
    sweepRunning = false;
  }
}

async function poll() {
  let stat;
  try {
    stat = fs.statSync(LOG_PATH);
  } catch (_) {
    return; // log not present yet
  }
  if (stat.size < lastSize) lastSize = 0; // rotated
  if (stat.size === lastSize) return;

  const stream = fs.createReadStream(LOG_PATH, { start: lastSize, end: stat.size });
  let buf = '';
  stream.on('data', (chunk) => (buf += chunk));
  stream.on('end', async () => {
    lastSize = stat.size;
    const lines = buf.split('\n');
    for (const line of lines) {
      if (isProviderFailureLine(line)) {
        const suspect = extractFailedProvider(line);
        await onProviderFailure(suspect, line);
        break; // one failover per poll cycle
      }
    }
  });
}

async function main() {
  log(`watching ${LOG_PATH}`);
  log(`priority: ${(process.env.OKX_PROVIDER_PRIORITY || 'claude,codex,hermes')}`);
  try {
    lastSize = fs.statSync(LOG_PATH).size; // start from the tail; ignore past failures
  } catch (_) {
    lastSize = 0;
  }
  // Verify a provider is up front, before any job arrives.
  const boot = await ensureWorkingProvider();
  log('startup check:', boot.message || boot.action);
  // Covers jobs stuck by a failure that happened before this process started
  // (this watchdog is not itself supervised — nothing restarts it if it dies,
  // so there is always a window where a failure could go undetected).
  await runRecoverySweep('startup');

  setInterval(() => {
    poll().catch((e) => log('poll error:', e.message));
  }, POLL_MS);

  setInterval(() => {
    runRecoverySweep('periodic').catch((e) => log('sweep error:', e.message));
  }, RECOVERY_SWEEP_MS);
}

main();
