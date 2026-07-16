#!/usr/bin/env node
/**
 * self-test.js — end-to-end live proof that the ASP pipeline works unattended.
 *
 * Publishes a real designated job to our OWN ASP and lets the okx-a2a daemon
 * apply and deliver with no human in the loop. This is the only way to exercise
 * the full path — apply, escrow, deliver — without waiting for a counterparty
 * to test us, and the only way to catch a broken deliver step BEFORE a real
 * buyer's escrow is sitting in it.
 *
 * REQUIRES TWO WALLETS. OKX_AGENT_ID (buyer) and OKX_ASP_AGENT_ID (provider)
 * must be owned by DIFFERENT wallets. A wallet cannot hire itself: create-task
 * fails with "Wallet API error (code=1001): designated provider not match:
 * <asp>". On a normal single-account setup both agents share one wallet, so
 * this script cannot pass — postTaskAndCollectBids will (correctly) withhold
 * our own bid and it exits with "no bid from our own ASP". That is the expected
 * result, not a regression; see docs/LIVE_OKX_SETUP.md. Point OKX_AGENT_ID at a
 * user agent on a second account to actually run this.
 *
 * SPENDS REAL MONEY: funds an on-chain escrow of OKX_ASP_SERVICE_FEE_USDT from
 * the agentic wallet. It is a real transaction on XLayer.
 *
 * Usage:
 *   npm run self-test
 *
 * Then watch ~/.okx-agent-task/logs/listener.log: the daemon should emit
 * job_asp_selected -> apply -> job_accepted -> deliver, all on its own.
 */

const path = require('path');
// Resolve .env from the repo, not cwd — same trap that made rank-for-job.js
// silently fall back to mock mode when the daemon invoked it.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  postTaskAndCollectBids,
  approveAndFundEscrow,
  MODE,
} = require('../lib/marketplaceClient');

const ASP_ID = process.env.OKX_ASP_AGENT_ID || '4814';

const task = {
  title: 'Quote Runner self-test',
  description: 'Find me a token audit provider',
  budget_usdt: Number(process.env.OKX_ASP_SERVICE_FEE_USDT || 0.01),
  deadline_hours: 24,
  category: 'other',
};

(async () => {
  if (MODE !== 'live') {
    throw new Error(`MARKETPLACE_MODE is "${MODE}", not "live" — refusing self-test.`);
  }
  console.log('[self-test] mode:', MODE);

  const { bids } = await postTaskAndCollectBids(task);
  console.log('[self-test] bids returned:', bids.length);

  const mine = bids.find((b) => String(b.agent_id) === String(ASP_ID));
  if (!mine) throw new Error(`no bid from our own ASP ${ASP_ID} — is the service still listed?`);
  console.log(
    `[self-test] hiring our own ASP: ${mine.agent_name} (#${mine.agent_id}) ` +
      `service ${mine.bid_id} @ ${mine.price_usdt} USDT`
  );

  console.log('[self-test] create-task -> set-payment-mode -> confirm-accept');
  console.log('[self-test] confirm-accept retries until the daemon applies on-chain...');
  const t0 = Date.now();
  const result = await approveAndFundEscrow(null, mine.bid_id, task, mine);
  const secs = Math.round((Date.now() - t0) / 1000);

  console.log(`\n[self-test] ESCROW FUNDED in ${secs}s`);
  console.log('  jobId:    ', result.task_id);
  console.log('  escrow tx:', result.escrow_tx);
  console.log('\n[self-test] The daemon should now deliver UNATTENDED. Watch:');
  console.log('  tail -f ~/.okx-agent-task/logs/listener.log');
  console.log(`  onchainos agent status ${result.task_id}   # expect: submitted`);
})().catch((err) => {
  console.error('\n[self-test] FAILED:', err.message);
  if (err.code) console.error('  code:', err.code);
  process.exit(1);
});
