/**
 * scoringEngine.js
 * Ranks marketplace bids using a transparent, weighted formula, and
 * generates a plain-language explanation for the top recommendation.
 *
 * This is Quote Runner's core differentiation: not "cheapest wins," but
 * a defensible, explainable score across price, reputation, and speed.
 */

const DEFAULT_WEIGHTS = {
  price: 0.4,
  reputation: 0.4,
  speed: 0.2,
};

/**
 * Normalize a value to a 0-1 score where higher is better.
 */
function normalize(value, min, max, invert = false) {
  if (max === min) return 1;
  const clamped = Math.min(Math.max(value, min), max);
  const score = (clamped - min) / (max - min);
  return invert ? 1 - score : score;
}

/**
 * Score a price against the task budget, where lower is better.
 *
 * The budget is the reference, NOT the spread of the other bids. Min-max
 * normalising price across bids lets one outlier own the entire scale: for a
 * real 0.01 USDT job the bids were 0, 0.001, 0.05, 0.1 … 50, and that lone 50
 * compressed every other option to a sub-score of 100 — including ones 5x over
 * budget. Price carries 40% of the weight, so that silently handed the whole
 * decision to reputation and recommended a 0.05 provider for a 0.01 task.
 *
 * Anchoring to the budget keeps the sub-score meaningful no matter what else
 * is listed: spend none of it -> 100, spend all of it -> 0.
 *
 * With no usable budget we fall back to a spread-relative score, which has the
 * outlier weakness described above but is the only reference available.
 */
function scorePrice(price, budgetUsdt, maxPrice) {
  const budget = Number(budgetUsdt) || 0;
  if (budget > 0) {
    if (price > budget) return 0; // over budget — also excluded from the top spot below
    return 1 - price / budget;
  }
  if (maxPrice > 0) return 1 - Math.min(price, maxPrice) / maxPrice;
  return 1; // everything is free
}

/**
 * Score and rank bids for a given task.
 *
 * Two constraints outrank the weighted score, and neither is a preference:
 *
 *   off_scope   — the service cannot do the task at all (set upstream by
 *                 lib/relevance.js). No price makes a localization service the
 *                 right answer for a logo job.
 *   over_budget — the service costs more than the buyer has.
 *
 * A bid failing either can never outrank one that passes, regardless of
 * reputation. Both are still returned and flagged so the buyer sees what was
 * considered and can overrule us — they just never take the recommendation slot.
 *
 * off_scope is checked first because it is the stronger disqualifier: an
 * in-budget service that cannot do the work is worth less than an over-budget
 * one that can.
 *
 * @param {object} task - structured task (has budget_usdt, deadline_hours)
 * @param {Array} bids - bid objects from marketplaceClient, ideally already
 *                       annotated with .off_scope by relevance.judgeBids. An
 *                       unannotated bid counts as in-scope, so callers that
 *                       skip the relevance pass get the old behaviour rather
 *                       than a silently empty shortlist.
 * @param {object} weights - optional override of {price, reputation, speed}
 * @returns {Array} sorted best-first, each annotated with .score, .over_budget,
 *                  .off_scope and .score_breakdown
 */
function rankBids(task, bids, weights = DEFAULT_WEIGHTS) {
  if (!bids || bids.length === 0) return [];

  const etas = bids.map((b) => b.eta_hours);
  const minEta = Math.min(...etas);
  const maxEta = Math.max(...etas);
  const maxPrice = Math.max(...bids.map((b) => b.price_usdt));
  const budget = Number(task?.budget_usdt) || 0;

  const scored = bids.map((bid) => {
    const priceScore = scorePrice(bid.price_usdt, budget, maxPrice);
    // Reputation: assume 0-5 scale, higher is better
    const reputationScore = normalize(bid.reputation, 0, 5, false);
    // Speed: lower ETA relative to the field is better -> invert
    const speedScore = normalize(bid.eta_hours, minEta, maxEta, true);

    const finalScore =
      priceScore * weights.price +
      reputationScore * weights.reputation +
      speedScore * weights.speed;

    return {
      ...bid,
      score: Math.round(finalScore * 1000) / 1000,
      over_budget: budget > 0 && bid.price_usdt > budget,
      off_scope: Boolean(bid.off_scope),
      score_breakdown: {
        price: Math.round(priceScore * 100),
        reputation: Math.round(reputationScore * 100),
        speed: Math.round(speedScore * 100),
      },
    };
  });

  // Capable bids first, then affordable ones, then by score. Sorting on score
  // alone would let a pricey 5-star bid beat an in-budget one on reputation and
  // speed — and would let a cheap 5-star bid that cannot do the job beat both.
  return scored.sort((a, b) => {
    if (a.off_scope !== b.off_scope) return a.off_scope ? 1 : -1;
    if (a.over_budget !== b.over_budget) return a.over_budget ? 1 : -1;
    return b.score - a.score;
  });
}

/**
 * Build a short plain-language explanation for why the top bid was chosen,
 * comparing it against the next-best alternative. No LLM call needed --
 * deterministic and instant, good for demo reliability.
 */
function explainTopChoice(rankedBids, task) {
  if (rankedBids.length === 0) {
    return 'No bids received yet.';
  }

  const budget = Number(task?.budget_usdt) || 0;
  const inScope = rankedBids.filter((b) => !b.off_scope);
  const offScopeCount = rankedBids.length - inScope.length;

  // Every candidate does a different kind of work. This must never read as a
  // recommendation: discovery returning nine services says nothing about whether
  // any of them can do the job, and picking the cheapest of nine wrong answers is
  // how "Chose Crypto Doc Localization over Full brand kit — 40% cheaper" got
  // written for a logo task.
  if (inScope.length === 0) {
    const closest = rankedBids[0];
    return (
      `No suitable provider found. All ${rankedBids.length} service(s) that marketplace ` +
      `discovery returned do a different kind of work — the nearest was ${closest.agent_name} ` +
      `(${closest.scope_reason || 'not a capability match'}). They are listed below so you can ` +
      `see what was considered, but none of them can do this task; a new search or a ` +
      `reworded request is more likely to help than hiring from this list.`
    );
  }

  // Named once, appended to every real recommendation below: the buyer sees rows
  // in the table that the recommendation deliberately skipped, and silence there
  // reads like an oversight.
  const offScopeNote =
    offScopeCount > 0
      ? ` (${offScopeCount} other service${offScopeCount === 1 ? '' : 's'} matched the search but ` +
        `do${offScopeCount === 1 ? 'es' : ''} a different kind of work — listed below, not ranked for this.)`
      : '';

  if (inScope.length === 1) {
    const only = inScope[0];
    return (
      `${only.agent_name} is the only provider that can actually do this — ` +
      `${only.price_usdt} USDT, ${only.eta_hours}h ETA, ${only.reputation}★ reputation.` +
      offScopeNote
    );
  }

  // Compare against the next-best bid that can also do the job. Ranking against
  // rankedBids[1] would justify the pick with "40% cheaper than <service that
  // cannot do the task>" — true, and meaningless.
  const [top, runnerUp] = inScope;
  const parts = [];

  if (top.price_usdt < runnerUp.price_usdt) {
    const pctCheaper = Math.round(
      ((runnerUp.price_usdt - top.price_usdt) / runnerUp.price_usdt) * 100
    );
    if (pctCheaper > 0) parts.push(`${pctCheaper}% cheaper`);
  }
  if (top.reputation > runnerUp.reputation) {
    parts.push(`${top.reputation}★ reputation vs ${runnerUp.reputation}★`);
  }
  if (top.eta_hours < runnerUp.eta_hours) {
    parts.push(`${runnerUp.eta_hours - top.eta_hours}h faster`);
  }
  // The decisive reason whenever we passed over a stronger-looking bid.
  if (!top.over_budget && runnerUp.over_budget) {
    parts.push(`within your ${budget} USDT budget (${runnerUp.price_usdt} USDT is over)`);
  }

  const reasonStr =
    parts.length > 0
      ? parts.join(', ')
      : 'the strongest overall balance of price, reputation, and speed';

  // "Chose X over Y — <reasons>." reads correctly for every reason phrasing.
  // Appending "than the next best option" only works for comparatives, and
  // mangles the rest: "4.75★ reputation vs 4★ than the next best option".
  const lead = `Chose ${top.agent_name} over ${runnerUp.agent_name} — ${reasonStr}.`;

  // Never let an all-over-budget shortlist read like a clean recommendation.
  if (top.over_budget) {
    return (
      `${lead} Note: every matching provider quoted above your ${budget} USDT budget — ` +
      `${top.agent_name} is the closest fit at ${top.price_usdt} USDT, but you would need ` +
      `to raise the budget to hire it.` +
      offScopeNote
    );
  }
  return lead + offScopeNote;
}

module.exports = { rankBids, explainTopChoice, scorePrice, DEFAULT_WEIGHTS };
