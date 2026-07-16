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
 * Budget is treated as a constraint, not a preference: a bid that exceeds it
 * can never outrank one that fits, regardless of reputation. Over-budget bids
 * are still returned (and flagged) so the buyer can see what was considered
 * and overrule us — they just never take the recommendation slot.
 *
 * @param {object} task - structured task (has budget_usdt, deadline_hours)
 * @param {Array} bids - array of bid objects from marketplaceClient
 * @param {object} weights - optional override of {price, reputation, speed}
 * @returns {Array} sorted best-first, each annotated with .score, .over_budget
 *                  and .score_breakdown
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
      score_breakdown: {
        price: Math.round(priceScore * 100),
        reputation: Math.round(reputationScore * 100),
        speed: Math.round(speedScore * 100),
      },
    };
  });

  // Affordable bids first, then by score. Sorting on score alone would let a
  // pricey 5-star bid beat an in-budget one on reputation and speed.
  return scored.sort((a, b) => {
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
  if (rankedBids.length === 1) {
    const only = rankedBids[0];
    return `${only.agent_name} is the only bidder so far — ${only.price_usdt} USDT, ${only.eta_hours}h ETA, ${only.reputation}★ reputation.`;
  }

  const [top, runnerUp] = rankedBids;
  const budget = Number(task?.budget_usdt) || 0;
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
      `to raise the budget to hire it.`
    );
  }
  return lead;
}

module.exports = { rankBids, explainTopChoice, scorePrice, DEFAULT_WEIGHTS };
