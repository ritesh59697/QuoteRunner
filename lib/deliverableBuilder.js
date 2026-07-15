/**
 * deliverableBuilder.js
 * Produces the ASP deliverable for an accepted job from Quote Runner's REAL
 * ranking pipeline — the marketplace asp-match results scored by
 * scoringEngine.js — instead of letting the daemon AI improvise one.
 *
 * Why this exists: when a job reaches `job_accepted`, the daemon hands it to
 * an AI runtime to produce the deliverable. Left to itself that runtime
 * invents providers and hallucinates the budget (observed 2026-07-15: it
 * delivered made-up agents and a "~20 USDT" budget for a 0.01 USDT task).
 * This module makes the deliverable deterministic and grounded in real data:
 * real matched providers, real fees, transparent price/reputation/speed score.
 */

const {
  postTaskAndCollectBids,
  MODE,
} = require('./marketplaceClient');
const { rankBids, explainTopChoice } = require('./scoringEngine');

const SELF_ASP_ID = process.env.OKX_ASP_AGENT_ID || '4814';

/**
 * Build a structured task from what we can read off-chain for a job.
 * We don't need an LLM here — asp-match keys off the description text, and the
 * on-chain budget is authoritative (never guess it, that's the bug we're fixing).
 */
function taskFromJob({ title, description, budgetUsdt, deadlineHours }) {
  const desc = (description && description.trim()) || title || '';
  return {
    title: title || desc.slice(0, 40) || 'Task',
    description: desc,
    budget_usdt: Number(budgetUsdt) || 0,
    deadline_hours: Number(deadlineHours) || 24,
    category: 'other',
  };
}

/**
 * Run the real pipeline for a task and return the ranked shortlist +
 * explanation + a formatted markdown deliverable. Excludes our own ASP so we
 * never rank ourselves into a job we were hired to adjudicate.
 */
async function buildDeliverable(task) {
  const { bids } = await postTaskAndCollectBids(task);
  const candidates = (bids || []).filter(
    (b) => String(b.agent_id) !== String(SELF_ASP_ID)
  );

  const ranked = rankBids(task, candidates);
  const explanation = explainTopChoice(ranked, task);
  const markdown = formatMarkdown(task, ranked, explanation);

  return { task, ranked, explanation, markdown, candidateCount: candidates.length };
}

function formatMarkdown(task, ranked, explanation) {
  const lines = [];
  lines.push(`# Quote Comparison & Ranking`);
  lines.push('');
  lines.push(`**Task:** ${task.title}`);
  lines.push(`**Budget:** ${task.budget_usdt} USDT · **Deadline:** ${task.deadline_hours}h`);
  lines.push(`**Providers evaluated:** ${ranked.length}`);
  lines.push('');

  if (ranked.length === 0) {
    lines.push(
      '_No matching providers were listed on the marketplace for this task at ranking time._'
    );
    return lines.join('\n');
  }

  lines.push(`**Recommendation:** ${explanation}`);
  lines.push('');
  lines.push('| # | Provider | Score | Price (USDT) | Reputation | ETA (h) | Price/Rep/Speed |');
  lines.push('|---|---|---|---|---|---|---|');
  ranked.forEach((b, i) => {
    const bd = b.score_breakdown || {};
    lines.push(
      `| ${i + 1} | ${b.agent_name} (#${b.agent_id}) | ${b.score} | ${b.price_usdt} | ` +
        `${b.reputation}★ | ${b.eta_hours} | ${bd.price}/${bd.reputation}/${bd.speed} |`
    );
  });
  lines.push('');
  lines.push(
    '_Scored by Quote Runner: weighted price (40%), reputation (40%), speed (20%). ' +
      'Sub-scores are 0–100, higher is better._'
  );
  return lines.join('\n');
}

module.exports = { buildDeliverable, taskFromJob, formatMarkdown, MODE };
