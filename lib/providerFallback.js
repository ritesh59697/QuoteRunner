/**
 * providerFallback.js
 * Automatic AI-provider failover for the OKX A2A daemon.
 *
 * The daemon dispatches every inbound job event to ONE bound AI CLI
 * (claude | codex | hermes | openclaw). If that CLI cannot run — expired
 * login, exhausted quota — the event is received and then silently dropped:
 * apply/deliver never happen and the job expires with escrow stuck. This
 * happened twice on 2026-07-15 (claude OAuth expired; codex quota exhausted),
 * each time invisibly, because the agent still reported itself "online".
 *
 * The daemon has no native fallback chain, so this module provides one:
 * detect the active provider failing and switch the daemon to the next
 * working provider in a priority list. hermes is kept last as a free,
 * always-local safety net.
 *
 * Detection is REACTIVE, not periodic: we do not probe claude/codex on a
 * timer, because probing consumes the very quota we are trying to conserve.
 * We only probe candidates during an actual failover.
 */

const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const A2A_BIN = process.env.OKX_A2A_BIN || 'okx-a2a';

// Priority order: try these left-to-right, first that responds wins.
// hermes last on purpose — free/local, no quota, the guaranteed floor.
const PROVIDER_PRIORITY = (process.env.OKX_PROVIDER_PRIORITY || 'claude,codex,hermes')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

// How the daemon's per-dispatch failures read in listener.log / session logs.
// Only treat provider-level failures (auth/quota) as failover triggers — a
// task-level error is the model's problem, not the provider's.
//
// Each provider words exhaustion differently, and a phrase that is not listed
// here is a silent hole: the watchdog never fires, the dead provider stays
// bound, and every invite is dropped. That is exactly how job 0x82d5e8 and
// 0xe51506 were lost on 2026-07-16 — claude said "You've hit your session
// limit", which matched nothing below, so no failover ran while doctor still
// reported the CLI green. Add the provider's literal wording when a new one
// appears in the logs; do not rely on a generic /limit/ catch-all, which also
// matches task-level model chatter.
const PROVIDER_DEAD_SIGNATURES = [
  /failed to authenticate/i,
  /oauth session expired/i,
  /authentication_failed/i,
  /hit your usage limit/i,
  /usage limit/i,
  /session limit/i, // claude: "You've hit your session limit · resets 3:40pm"
  /rate limit/i,
  /quota/i,
  /upgrade to plus/i,
  /insufficient credit/i,
];

// Headless one-shot probe command per provider. Kept to a 1-token reply.
function probeCommand(provider) {
  switch (provider) {
    case 'claude':
      return { bin: 'claude', args: ['-p', 'reply with: OK'] };
    case 'codex':
      return { bin: 'codex', args: ['exec', 'reply with: OK'] };
    case 'hermes':
      return { bin: 'hermes', args: ['-z', 'reply with: OK'] };
    case 'openclaw':
      return { bin: 'openclaw', args: ['-p', 'reply with: OK'] };
    default:
      return null;
  }
}

function looksDead(text) {
  return PROVIDER_DEAD_SIGNATURES.some((re) => re.test(String(text || '')));
}

/**
 * Does this listener.log line report a dispatch that died for a provider-level
 * reason (auth/quota) rather than a task-level one?
 *
 * The daemon logs a failed dispatch in two shapes, and they are NOT
 * interchangeable:
 *
 *   A. "AI session done ... provider=claude exitCode=1 ... result=stdout=
 *       "You've hit your session limit""      <- carries the reason
 *   B. "ai-dispatch/... command failed ...: claude CLI exited with code 1
 *       ...; stdout={"type":"system",...}"    <- reason truncated away
 *
 * codex writes its reason into B via `providerMessage=`, so matching only B
 * caught codex and silently missed every claude outage — the bug that lost
 * 0x82d5e8 and 0xe51506. Match both shapes.
 */
function isProviderFailureLine(line) {
  const text = String(line || '');
  const failed =
    /command failed|CLI exited/i.test(text) ||
    /AI session done\b[^\n]*\bexitCode=(?!0\b)\d+/i.test(text);
  return failed && looksDead(text);
}

/** Which provider died, from either line shape above. */
function extractFailedProvider(line) {
  const text = String(line || '');
  const m =
    text.match(/\b(claude|codex|hermes|openclaw)\s+CLI\s+exited/i) ||
    text.match(/\bprovider=(claude|codex|hermes|openclaw)\b/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Is `provider` actually usable right now? Runs a real headless call.
 * Returns { ok, reason }. Only called during failover, never on a timer.
 */
async function probeProvider(provider, { timeout = 60000 } = {}) {
  const cmd = probeCommand(provider);
  if (!cmd) return { ok: false, reason: `unknown provider ${provider}` };
  try {
    const { stdout, stderr } = await execFileAsync(cmd.bin, cmd.args, {
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
    });
    const out = `${stdout || ''}\n${stderr || ''}`;
    if (looksDead(out)) return { ok: false, reason: firstDeadLine(out) };
    if (!String(stdout || '').trim()) return { ok: false, reason: 'empty response' };
    return { ok: true, reason: 'responded' };
  } catch (err) {
    const out = `${err.stdout || ''}\n${err.stderr || ''}\n${err.message || ''}`;
    // ENOENT = not installed; treat as unavailable, not a hard error.
    return { ok: false, reason: looksDead(out) ? firstDeadLine(out) : err.message };
  }
}

function firstDeadLine(text) {
  const line = String(text)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => looksDead(l));
  return line ? line.slice(0, 160) : 'provider unavailable';
}

async function runA2a(args, { timeout = 60000 } = {}) {
  const { stdout } = await execFileAsync(A2A_BIN, args, {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });
  return stdout || '';
}

function parseJsonLoose(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch (_) {
    return null;
  }
}

async function getActiveProvider() {
  try {
    const out = await runA2a(['ai-provider', 'status', '--json'], { timeout: 15000 });
    return parseJsonLoose(out)?.provider || null;
  } catch (_) {
    return null;
  }
}

/**
 * Repair every per-job binding currently pointing at `fromProvider` so it
 * points at `toProvider`. Per-job bindings are sticky and do NOT follow the
 * global default — an in-flight job stays pinned to the dead provider unless
 * repaired, which is the specific trap that stranded job 0x25e59ff7 tonight.
 * Harmless for terminal jobs (they are never re-dispatched).
 */
async function repairJobBindings(fromProvider, toProvider) {
  const repaired = [];
  try {
    const out = await runA2a(['job-provider', 'list', '--json'], { timeout: 20000 });
    const bindings = parseJsonLoose(out)?.bindings || [];
    for (const b of bindings) {
      if (b.provider !== fromProvider) continue;
      try {
        await runA2a(
          ['job-provider', 'set', '--job-id', b.jobId, '--provider', toProvider, '--json'],
          { timeout: 20000 }
        );
        repaired.push(b.jobId);
      } catch (_) {
        /* best-effort per job */
      }
    }
  } catch (_) {
    /* listing failed — skip binding repair */
  }
  return repaired;
}

/**
 * Point the daemon at `toProvider`: set the stored default, restart the daemon
 * pinned to it (restart re-runs provider binding, so it MUST be passed
 * explicitly or it would rebind to whatever runtime is calling), and repair
 * in-flight job bindings off the dead provider.
 */
async function switchProvider(fromProvider, toProvider) {
  await runA2a(['ai-provider', 'set', '--provider', toProvider, '--json'], { timeout: 20000 });
  await runA2a(['daemon', 'restart', '--provider', toProvider], { timeout: 120000 });
  const repaired = fromProvider ? await repairJobBindings(fromProvider, toProvider) : [];
  return { switchedTo: toProvider, repairedJobs: repaired };
}

/**
 * Ensure a working provider is bound. If `suspectProvider` is given (from an
 * observed dispatch failure), that provider is treated as the prime suspect
 * and re-probed first. Walks PROVIDER_PRIORITY, binds the first that responds.
 *
 * Returns a report describing what it found and did. Does nothing (beyond a
 * probe) if the active provider is healthy.
 */
async function ensureWorkingProvider({ suspectProvider = null } = {}) {
  const active = await getActiveProvider();
  const report = { active, action: 'none', switchedTo: null, repairedJobs: [], probes: {} };

  // Probe the active provider first. If it's alive and not the suspect, done.
  if (active) {
    const probe = await probeProvider(active);
    report.probes[active] = probe;
    if (probe.ok && active !== suspectProvider) {
      report.action = 'healthy';
      report.message = `Active provider ${active} is healthy.`;
      return report;
    }
    if (probe.ok && active === suspectProvider) {
      // Suspected from a log line but actually responds now — transient. Keep it.
      report.action = 'healthy';
      report.message = `Active provider ${active} flagged from logs but responded; keeping it.`;
      return report;
    }
  }

  // Active is dead (or unset). Find the first working provider by priority.
  for (const candidate of PROVIDER_PRIORITY) {
    if (candidate === active) continue; // already probed above
    const probe = await probeProvider(candidate);
    report.probes[candidate] = probe;
    if (probe.ok) {
      const result = await switchProvider(active, candidate);
      report.action = 'switched';
      report.switchedTo = result.switchedTo;
      report.repairedJobs = result.repairedJobs;
      report.message =
        `Active provider ${active || 'none'} is down (${report.probes[active]?.reason || 'unset'}); ` +
        `switched to ${candidate}` +
        (result.repairedJobs.length ? `, repaired ${result.repairedJobs.length} job binding(s).` : '.');
      return report;
    }
  }

  report.action = 'exhausted';
  report.message =
    `No working AI provider found. Tried: ${PROVIDER_PRIORITY.join(', ')}. ` +
    `Inbound jobs cannot be fulfilled until one is restored (log in / clear quota).`;
  return report;
}

module.exports = {
  PROVIDER_PRIORITY,
  probeProvider,
  getActiveProvider,
  ensureWorkingProvider,
  switchProvider,
  looksDead,
  isProviderFailureLine,
  extractFailedProvider,
  PROVIDER_DEAD_SIGNATURES,
};
