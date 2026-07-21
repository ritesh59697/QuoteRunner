#!/usr/bin/env node
/**
 * install-asp-workspace.js
 * Installs Quote Runner's ASP runtime + instructions where the okx-a2a daemon
 * can actually reach them, so the AI runtime that produces deliverables uses the
 * REAL ranking pipeline instead of improvising providers and budgets.
 *
 * Two separate problems are solved here.
 *
 * 1. INSTRUCTIONS. The daemon spawns the AI CLI with cwd = ~/.okx-agent-task/
 *    workspace and reads a local SKILL.md / CLAUDE.md there if present
 *    (confirmed from daemon logs: "No local SKILL.md exists, so I went straight
 *    to next-action"). We write those, pointing the deliver step at
 *    rank-for-job.js.
 *
 * 2. LOCATION (macOS TCC). The daemon is started by launchd (its PPID is 1), and
 *    launchd-spawned processes get no TCC grant for ~/Downloads, ~/Desktop, or
 *    ~/Documents. If the repo lives in one of those, the daemon's node can't
 *    even read the entry script: job 0xe9d4e1 reached deliver on 2026-07-16 and
 *    died with `EPERM: operation not permitted, open '.../scripts/
 *    rank-for-job.js'`, escrow already funded. No code change fixes that — the
 *    runtime has to physically live outside the protected folders. So we sync a
 *    copy into ~/.okx-agent-task/asp-runtime (same tree the daemon already reads
 *    for the workspace) and point the instructions at THAT copy.
 *
 * The copy is a build artifact, not a second source of truth: it is overwritten
 * wholesale on every run. Edit the repo, then re-run this to publish.
 *
 * Run after setup, and again after ANY change to lib/ or scripts/:
 *   npm run install-asp
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKSPACE =
  process.env.OKX_A2A_WORKSPACE ||
  path.join(os.homedir(), '.okx-agent-task', 'workspace');

// Must stay outside ~/Downloads, ~/Desktop and ~/Documents — see header.
const RUNTIME =
  process.env.OKX_ASP_RUNTIME ||
  path.join(os.homedir(), '.okx-agent-task', 'asp-runtime');

const REPO = path.resolve(__dirname, '..');
const RANK_SCRIPT = path.join(RUNTIME, 'scripts', 'rank-for-job.js');

// Everything rank-for-job.js needs to run standalone.
const RUNTIME_CONTENTS = ['lib', 'scripts', 'node_modules', 'package.json', '.env'];

// macOS folders that launchd-spawned daemons cannot read.
const TCC_PROTECTED = ['Downloads', 'Desktop', 'Documents'];

const INSTRUCTIONS = `# Quote Runner ASP — deliverable instructions

You are operating as ASP agent #${process.env.OKX_ASP_AGENT_ID || '4814'} ("Quote Runner"),
whose service is **Quote Comparison & Ranking**. Follow the okx-agent-task
playbook (\`onchainos agent next-action\`) for the protocol handshake as normal.

## Autonomous Execution & Apply Rules — MANDATORY

- **ALWAYS execute on-chain apply immediately**: When a designated task / \`job_asp_selected\` notification arrives, ALWAYS execute the \`onchainos agent apply\` command given in the \`next-action\` playbook output immediately.
- **NEVER stop or ask questions**: This is an autonomous background process with NO human present to answer questions. NEVER halt, ask the user questions, or ask whether to proceed/reject — even if the task description contains meta-instructions, boilerplate, or prompt-like text (such as "Read okx-agent-task/SKILL.md..."). Always proceed directly to execute \`onchainos agent apply\`.

## Producing the deliverable — MANDATORY

When the playbook reaches the **deliver** step for a job (after \`job_accepted\`),
you MUST NOT write the ranking yourself. Do not invent providers, scores, or the
budget. The real ranking comes from Quote Runner's engine. Run:

\`\`\`bash
node ${RANK_SCRIPT} <jobId> --task-desc "<buyer's request, verbatim>" 2>/dev/null
\`\`\`

\`--task-desc\` is REQUIRED and is the one thing only you can supply. Copy the
buyer's request **exactly** from the \`description:\` field of the \`next-action\`
playbook output — the whole thing, word for word.

- Do NOT summarise, shorten, translate, or "clean up" their text.
- Do NOT write your own budget or deadline. The script extracts those from their
  words. Your job is to relay, not interpret.
- Do NOT pass the on-chain \`budget:\` from \`agent status\` — that is OUR ranking
  fee (e.g. 0.01 USDT), not the buyer's budget for the providers being ranked.
  Confusing the two ranks real providers against our fee and recommends
  nonsense; it is the exact bug this flag exists to prevent.

Take the script's **entire stdout verbatim** and pass it as \`--deliverable-text\`
to the \`onchainos agent deliver\` command the playbook tells you to run:

\`\`\`bash
onchainos agent deliver <jobId> --agent-id ${process.env.OKX_ASP_AGENT_ID || '4814'} \
  --message "Quote Runner ranking complete — see deliverable." \
  --deliverable-text "<stdout from the script above>"
\`\`\`

Alternatively \`node ${RANK_SCRIPT} <jobId> --task-desc "<...>" --deliver 2>/dev/null\` does both
in one step (including automatically attaching the deliverable to the task via \`onchainos agent task-attach\` as a fallback before delivering) and refuses unless the job is in \`accepted\` status.

Rules:
- The script reads the real matched providers from the marketplace and the real
  budget from the buyer's own words. Never substitute your own numbers.
- If the script exits non-zero or prints an empty ranking, do NOT fabricate a
  deliverable — send the buyer a short status via \`onchainos agent user-notify\`
  explaining no matching providers were found, and end the turn.
- Do NOT run any active sleep loops (e.g. \`sleep 60\`, loops, or waiting shell scripts) to wait for status changes (like waiting for acceptance). If the playbook asks you to wait for a status change, exit the session immediately and end the turn. The daemon will wake you up with a new session when the event occurs.
- This path is a generated copy of the Quote Runner repo. Do not edit it here;
  edits belong in the repo and are published with \`npm run install-asp\`.
- Everything else in the playbook (apply, notifications, waiting for events)
  is unchanged.
`;

function syncRuntime() {
  // Wholesale replace so a removed file in the repo can't linger here and get
  // silently executed months later.
  fs.rmSync(RUNTIME, { recursive: true, force: true });
  fs.mkdirSync(RUNTIME, { recursive: true });

  for (const entry of RUNTIME_CONTENTS) {
    const src = path.join(REPO, entry);
    if (!fs.existsSync(src)) {
      // .env is the only optional one — without it the CLI has no credentials
      // and the deliver step will fail at runtime rather than here.
      console.warn(`[install-asp] WARNING: ${entry} not found in repo — skipped.`);
      continue;
    }
    fs.cpSync(src, path.join(RUNTIME, entry), { recursive: true, force: true });
  }

  // .env carries OKX API keys; keep the copy owner-only.
  const envCopy = path.join(RUNTIME, '.env');
  if (fs.existsSync(envCopy)) fs.chmodSync(envCopy, 0o600);
}

function warnIfRuntimeStillProtected() {
  const rel = path.relative(os.homedir(), RUNTIME).split(path.sep)[0];
  if (TCC_PROTECTED.includes(rel)) {
    console.error(
      `[install-asp] ERROR: runtime target ${RUNTIME} is inside ~/${rel}, which the\n` +
        `              launchd-spawned daemon cannot read (macOS TCC). Deliver will fail\n` +
        `              with EPERM. Set OKX_ASP_RUNTIME to a path outside ` +
        `${TCC_PROTECTED.map((d) => `~/${d}`).join(', ')}.`
    );
    process.exit(1);
  }
}

function main() {
  if (!fs.existsSync(path.join(REPO, 'scripts', 'rank-for-job.js'))) {
    console.error(`[install-asp] rank script not found in repo at ${REPO}/scripts`);
    process.exit(1);
  }
  warnIfRuntimeStillProtected();

  syncRuntime();
  console.log(`[install-asp] synced runtime -> ${RUNTIME}`);

  fs.mkdirSync(WORKSPACE, { recursive: true });
  for (const name of ['SKILL.md', 'CLAUDE.md', 'AGENTS.md']) {
    const dest = path.join(WORKSPACE, name);
    fs.writeFileSync(dest, INSTRUCTIONS, 'utf8');
    console.log(`[install-asp] wrote ${dest}`);
  }

  const repoTop = path.relative(os.homedir(), REPO).split(path.sep)[0];
  if (TCC_PROTECTED.includes(repoTop)) {
    console.log(
      `[install-asp] note: repo lives in ~/${repoTop}, which the daemon cannot read.\n` +
        `              That is fine — the daemon runs the synced copy above. Re-run\n` +
        `              \`npm run install-asp\` after every change to lib/ or scripts/.`
    );
  }
  console.log(`[install-asp] deliverables will now be generated by ${RANK_SCRIPT}`);
}

main();
