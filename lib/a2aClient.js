/**
 * a2aClient.js
 * Readiness checks for the OKX A2A daemon — the channel that delivers
 * designated-task system events (job_asp_selected) to our ASP agent.
 *
 * Without a running daemon with our ASP among its active clients, inbound
 * job invites are never received and the task expires unapplied. Heartbeat
 * (onlineStatus) does NOT cover this — it is a separate path and stays green
 * even when the agent cannot receive a single job.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const { isProviderFailureLine, extractFailedProvider } = require('./providerFallback');

const A2A_BIN = process.env.OKX_A2A_BIN || 'okx-a2a';
const ASP_AGENT_ID = process.env.OKX_ASP_AGENT_ID;
const A2A_TIMEOUT_MS = Number(process.env.OKX_A2A_TIMEOUT_MS || 60000);

const LISTENER_LOG =
  process.env.OKX_A2A_LOG ||
  path.join(os.homedir(), '.okx-agent-task', 'logs', 'listener.log');

// A dispatch failure older than this is history, not a live outage.
const RECENT_DROP_WINDOW_MS = Number(process.env.OKX_DROP_WINDOW_MS || 60 * 60 * 1000);

/**
 * Did the daemon recently receive an invite and fail to dispatch it because the
 * bound AI CLI was unusable?
 *
 * `doctor` cannot answer this: a quota-exhausted CLI is still *logged in*, so
 * doctor prints a green "AI provider CLI" line while every inbound invite is
 * received and dropped. The only honest evidence is the daemon's own dispatch
 * failures, so read those. We scan the log tail rather than probing the CLI
 * because probing burns the very quota that is running out — and readiness runs
 * on a timer.
 */
function getRecentDispatchFailure({ now = Date.now() } = {}) {
  let text;
  try {
    const { size } = fs.statSync(LISTENER_LOG);
    const start = Math.max(0, size - 512 * 1024);
    const fd = fs.openSync(LISTENER_LOG, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return null; // no log yet — nothing to report
  }

  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!isProviderFailureLine(line)) continue;

    const stamp = parseLogTimestamp(line);
    if (stamp && now - stamp > RECENT_DROP_WINDOW_MS) return null; // stale; older ones are older still
    return {
      at: stamp ? new Date(stamp).toISOString() : null,
      provider: extractFailedProvider(line),
      reason:
        (line.match(/(You've hit your [^;"]+|Failed to authenticate[^;"]*)/i) || [])[1] || null,
    };
  }
  return null;
}

// Listener lines start with e.g. "[07/16/2026, 13:31:10.568] ..." in local time.
function parseLogTimestamp(line) {
  const m = line.match(/^\[(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, mo, d, y, hh, mm, ss] = m;
  const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  return Number.isNaN(t.getTime()) ? null : t.getTime();
}

async function runA2a(args, { timeout = A2A_TIMEOUT_MS, allowNonZeroExit = false } = {}) {
  try {
    const { stdout } = await execFileAsync(A2A_BIN, args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    return stdout || '';
  } catch (err) {
    // `doctor` exits non-zero whenever any check fails, including checks we
    // deliberately ignore — but it still prints its full report to stdout.
    if (allowNonZeroExit && err.stdout) return err.stdout;
    throw err;
  }
}

function parseJsonLoose(text) {
  if (!text) return null;
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

/**
 * Is the daemon running, and is our ASP agent among its active clients?
 *
 * `daemon status` prints "running pid=<n>" (not JSON).
 * `agent refresh --json` returns { ok, payload: { agentCount, activeClients } }.
 */
async function getA2aReadiness() {
  const result = {
    ready: false,
    daemon_running: false,
    daemon_pid: null,
    agent_count: null,
    active_clients: null,
    asp_agent_id: ASP_AGENT_ID || null,
    ai_provider: null,
    ai_provider_logged_in: null,
    recent_dispatch_failure: null,
    message: '',
  };

  try {
    const statusOut = await runA2a(['daemon', 'status'], { timeout: 15000 });
    const pidMatch = String(statusOut).match(/running\s+pid=(\d+)/i);
    result.daemon_running = Boolean(pidMatch);
    result.daemon_pid = pidMatch ? Number(pidMatch[1]) : null;
  } catch (err) {
    result.message =
      `Cannot reach the okx-a2a CLI (${A2A_BIN}). Inbound job invites cannot be received. ` +
      `Install it (npm install -g @okxweb3/a2a-node@latest) or set OKX_A2A_BIN. ${err.message}`;
    return result;
  }

  if (!result.daemon_running) {
    result.message =
      'A2A daemon is NOT running — designated task invites cannot be received and will ' +
      'expire unapplied. Run: okx-a2a daemon start';
    return result;
  }

  try {
    const refreshOut = await runA2a(['agent', 'refresh', '--json']);
    const json = parseJsonLoose(refreshOut);
    const payload = json?.payload || {};
    result.agent_count = payload.agentCount ?? null;
    result.active_clients = payload.activeClients ?? null;
  } catch (err) {
    result.message = `A2A daemon is running but agent refresh failed: ${err.message}`;
    return result;
  }

  if (!result.active_clients || result.active_clients < 1) {
    result.message =
      'A2A daemon is running but has no active agent clients — invites will not be ' +
      'delivered. Run: okx-a2a agent refresh --json';
    return result;
  }

  // The daemon hands each inbound invite to the bound AI CLI, which runs
  // `next-action`. If that CLI cannot authenticate, the invite is received and
  // then silently dropped — this is what happened on 2026-07-15: the daemon
  // spawned Claude, Claude returned 401 "OAuth session expired", next-action
  // never ran, and the job expired unapplied while every other signal was green.
  //
  // So we check only that: is the bound provider's CLI actually logged in.
  //
  // We deliberately IGNORE doctor's "default provider does not match the
  // detected runtime" check. Doctor detects whichever AI runtime is calling it,
  // so that line goes red whenever a different tool runs it than the one that
  // is bound — a false alarm. Acting on it (doctor --fix) rebinds the provider
  // to the caller, which is how a working binding gets clobbered.
  try {
    const doctorOut = await runA2a(['doctor', '--non-interactive'], {
      timeout: 30000,
      allowNonZeroExit: true,
    });
    const providerLine = String(doctorOut)
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /AI provider CLI:/i.test(line));

    if (!providerLine) {
      result.ai_provider_logged_in = false;
      result.message =
        'A2A daemon is running, but doctor did not report on the AI provider CLI. ' +
        'Inbound invites may not reach next-action.';
      return result;
    }

    const providerMatch = providerLine.match(/AI provider CLI:\s*(\w+)/i);
    result.ai_provider = providerMatch ? providerMatch[1] : null;
    result.ai_provider_logged_in = providerLine.startsWith('✓');

    if (!result.ai_provider_logged_in) {
      result.message =
        `A2A daemon is running, but the bound AI provider ` +
        `(${result.ai_provider || 'unknown'}) is NOT usable — inbound invites will be ` +
        `received and then dropped before next-action. Log that CLI back in. ` +
        `Do NOT run \`okx-a2a doctor --fix\` from a different AI tool: it rebinds the ` +
        `provider to whichever runtime calls it. (${providerLine})`;
      return result;
    }
  } catch (err) {
    result.ai_provider_logged_in = false;
    result.message =
      'A2A daemon is running, but doctor could not be run to verify the AI provider: ' +
      err.message;
    return result;
  }

  // Logged in is not the same as usable. If the daemon has recently dropped a
  // real invite because the bound CLI was out of quota, we are NOT ready, no
  // matter how green doctor looks — this is the state that lost jobs 0x82d5e8
  // and 0xe51506 while every other signal said fine.
  const drop = getRecentDispatchFailure();
  if (drop) {
    result.recent_dispatch_failure = drop;
    result.ai_provider_logged_in = true; // it is; that is precisely the trap
    result.message =
      `A2A daemon is running and ${result.ai_provider || 'the bound provider'} is logged in, but ` +
      `the daemon DROPPED a job invite at ${drop.at || 'a recent time'}` +
      (drop.provider ? ` — ${drop.provider} exited without applying` : '') +
      (drop.reason ? `: "${drop.reason.trim()}"` : '') +
      `. A logged-in but quota-exhausted CLI never reaches next-action, so no apply tx is ` +
      `broadcast and the task expires unapplied. Restore that provider's quota or let the ` +
      `watchdog fail over (npm run watchdog).`;
    return result;
  }

  result.ready = true;
  result.message =
    `A2A ready · daemon pid ${result.daemon_pid} · ${result.active_clients} active client(s)` +
    (result.ai_provider ? ` · provider ${result.ai_provider} logged in` : '') +
    (ASP_AGENT_ID ? ` · ASP #${ASP_AGENT_ID}` : '');
  return result;
}

module.exports = { getA2aReadiness };
