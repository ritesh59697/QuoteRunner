/**
 * scoring.test.js
 * Locks the constraints that rankBids/explainTopChoice must never lose again.
 *
 * Every case here is a bug that actually shipped and reached a buyer. They are
 * pure-function tests on purpose: no Groq, no onchainos, no network, so they run
 * anywhere in under a second and there is no excuse not to.
 *
 *   node --test test/
 */

const test = require('node:test');
const assert = require('node:assert');
const { rankBids, explainTopChoice } = require('../lib/scoringEngine');

const task = { title: 'Logo', description: 'design a logo', budget_usdt: 20, deadline_hours: 48 };

function bid(name, { price = 1, rep = 4, off = false, reason = '' } = {}) {
  return {
    bid_id: name,
    agent_id: name,
    agent_name: name,
    price_usdt: price,
    reputation: rep,
    eta_hours: 48,
    off_scope: off,
    scope_reason: reason,
  };
}

test('a cheap 5-star service that cannot do the task never outranks one that can', () => {
  // Shipped 2026-07-17 on job 0xe51506: "Crypto Doc Localization" (0.15 USDT,
  // 5★) scored 0.997 and took the top slot on a logo job, over "Full brand kit".
  const ranked = rankBids(task, [
    bid('Localization', { price: 0.15, rep: 5, off: true, reason: 'localizes documents' }),
    bid('BrandKit', { price: 5, rep: 4 }),
  ]);
  assert.equal(ranked[0].agent_name, 'BrandKit');
});

test('off_scope disqualifies harder than over_budget', () => {
  // An in-budget service that cannot do the work is worth less than an
  // over-budget one that can: the buyer can raise a budget, not a capability.
  const ranked = rankBids(task, [
    bid('Localization', { price: 0.15, rep: 5, off: true, reason: 'localizes documents' }),
    bid('BrandKit', { price: 999, rep: 5 }),
  ]);
  assert.equal(ranked[0].agent_name, 'BrandKit');
  assert.equal(ranked[0].over_budget, true);
});

test('an all-off-scope shortlist never reads as a recommendation', () => {
  const ranked = rankBids(task, [
    bid('Localization', { price: 0.15, rep: 5, off: true, reason: 'localizes documents' }),
  ]);
  const explanation = explainTopChoice(ranked, task);
  assert.match(explanation, /No suitable provider found/);
  assert.doesNotMatch(explanation, /^Chose /);
});

test('the recommendation compares against the next in-scope bid, not an off-scope one', () => {
  // "40% cheaper than <service that cannot do the task>" is true and meaningless.
  const ranked = rankBids(task, [
    bid('BrandKit', { price: 5, rep: 5 }),
    bid('Cheap', { price: 0.1, rep: 5, off: true, reason: 'wrong service type' }),
    bid('Logos', { price: 6, rep: 4 }),
  ]);
  const explanation = explainTopChoice(ranked, task);
  assert.match(explanation, /Chose BrandKit over Logos/);
  assert.doesNotMatch(explanation, /Cheap/);
});

test('bids with no scope annotation are treated as in-scope', () => {
  // rankBids has callers that may not run the relevance pass. They must degrade
  // to the old behaviour, not to an empty shortlist.
  const ranked = rankBids(task, [
    { bid_id: 'a', agent_name: 'A', price_usdt: 1, reputation: 5, eta_hours: 48 },
  ]);
  assert.equal(ranked[0].off_scope, false);
  assert.match(explainTopChoice(ranked, task), /only provider/);
});

test('a provider quoting over budget never outranks one that fits', () => {
  // Shipped 2026-07-15: price was min-max normalised across bids, so a lone
  // outlier compressed the scale and handed the decision to reputation.
  const ranked = rankBids(task, [
    bid('Pricey', { price: 50, rep: 5 }),
    bid('Fits', { price: 10, rep: 4 }),
  ]);
  assert.equal(ranked[0].agent_name, 'Fits');
  assert.equal(ranked[0].over_budget, false);
});

test('the buyer budget is the price reference, not our service fee', () => {
  // Shipped 2026-07-16 on job 0x4d8458: scoring against our own 0.01 USDT
  // ranking fee marked every real logo provider "over budget".
  const ranked = rankBids(task, [bid('Designer', { price: 15, rep: 5 })]);
  assert.equal(ranked[0].over_budget, false, '15 USDT is inside the buyer 20 USDT budget');
});
