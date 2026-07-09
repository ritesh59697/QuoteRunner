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
 * Score and rank bids for a given task.
 * @param {object} task - structured task (has budget_usdt, deadline_hours)
 * @param {Array} bids - array of bid objects from marketplaceClient
 * @param {object} weights - optional override of {price, reputation, speed}
 * @returns {Array} bids sorted by score desc, each annotated with .score and .score_breakdown
 */
function rankBids(task, bids, weights = DEFAULT_WEIGHTS) {
  if (!bids || bids.length === 0) return [];

  const prices = bids.map((b) => b.price_usdt);
  const etas = bids.map((b) => b.eta_hours);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const minEta = Math.min(...etas);
  const maxEta = Math.max(...etas);

  const scored = bids.map((bid) => {
    // Price: lower is better -> invert
    const priceScore = normalize(bid.price_usdt, minPrice, maxPrice, true);
    // Reputation: assume 0-5 scale, higher is better
    const reputationScore = normalize(bid.reputation, 0, 5, false);
    // Speed: lower ETA relative to deadline is better -> invert
    const speedScore = normalize(bid.eta_hours, minEta, maxEta, true);

    const finalScore =
      priceScore * weights.price +
      reputationScore * weights.reputation +
      speedScore * weights.speed;

    return {
      ...bid,
      score: Math.round(finalScore * 1000) / 1000,
      score_breakdown: {
        price: Math.round(priceScore * 100),
        reputation: Math.round(reputationScore * 100),
        speed: Math.round(speedScore * 100),
      },
    };
  });

  return scored.sort((a, b) => b.score - a.score);
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

  const reasonStr = parts.length > 0 ? parts.join(', ') : 'the strongest overall balance of price, reputation, and speed';

  return `Chose ${top.agent_name} — ${reasonStr} than the next best option (${runnerUp.agent_name}).`;
}

module.exports = { rankBids, explainTopChoice, DEFAULT_WEIGHTS };
