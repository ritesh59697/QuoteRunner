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
const { judgeBids } = require('./relevance');

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
 *
 * Candidates are relevance-judged before scoring. asp-match is a loose
 * recommender, and scoring alone cannot tell "designs logos" from "localizes
 * documents" — it only sees price, stars, and ETA, on which the wrong service
 * often looks better. judgeBids throws rather than guessing; we let that
 * propagate, because a shortlist we could not judge is precisely the one that
 * must not go on-chain as a confident recommendation.
 */
async function buildDeliverable(task) {
  const { bids } = await postTaskAndCollectBids(task);
  const candidates = (bids || []).filter(
    (b) => String(b.agent_id) !== String(SELF_ASP_ID)
  );

  const judged = await judgeBids(task, candidates);
  const ranked = rankBids(task, judged);
  const explanation = explainTopChoice(ranked, task);
  const markdown = formatMarkdown(task, ranked, explanation);

  const inScopeCount = ranked.filter((b) => !b.off_scope).length;
  return {
    task,
    ranked,
    explanation,
    markdown,
    candidateCount: candidates.length,
    inScopeCount,
  };
}

function formatMarkdown(task, ranked, explanation) {
  const lines = [];
  lines.push(`# Quote Comparison & Ranking`);
  lines.push('');
  const inScope = ranked.filter((b) => !b.off_scope);
  const offScopeCount = ranked.length - inScope.length;

  lines.push(`**Task:** ${task.title}`);
  lines.push(`**Budget:** ${task.budget_usdt} USDT · **Deadline:** ${task.deadline_hours}h`);
  // "Providers evaluated: 9" overstates the shortlist when six of the nine do
  // something else entirely. Lead with the number that can actually do the work.
  lines.push(
    `**Providers evaluated:** ${ranked.length}` +
      (offScopeCount > 0
        ? ` · **able to do this task:** ${inScope.length} (${offScopeCount} listed but out of scope)`
        : '')
  );
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
    const price = b.over_budget ? `${b.price_usdt} ⚠ over budget` : `${b.price_usdt}`;
    const name = b.off_scope
      ? `${b.agent_name} (#${b.agent_id}) ⚠ out of scope${b.scope_reason ? ` — ${b.scope_reason}` : ''}`
      : `${b.agent_name} (#${b.agent_id})`;
    // An out-of-scope row showing 0.997 while sorted last invites the obvious
    // question. The weighted score genuinely does not apply to it: it was
    // disqualified on capability, not out-pointed on price.
    const score = b.off_scope ? '—' : b.score;
    lines.push(
      `| ${i + 1} | ${name} | ${score} | ${price} | ` +
        `${b.reputation}★ | ${b.eta_hours} | ${bd.price}/${bd.reputation}/${bd.speed} |`
    );
  });
  lines.push('');
  lines.push(
    '_Scored by Quote Runner: providers that cannot do the task are excluded from the ' +
      'recommendation regardless of price, then the rest are ranked on weighted price (40%), ' +
      'reputation (40%), speed (20%). Sub-scores are 0–100, higher is better. Price is scored ' +
      'against your budget — spend none of it for 100, all of it for 0 — and a provider quoting ' +
      'over budget is never recommended above one that fits. Everything discovered is listed, ' +
      'including what we ruled out and why._'
  );
  return lines.join('\n');
}

module.exports = { buildDeliverable, taskFromJob, formatMarkdown, MODE };
