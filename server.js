require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const {
  parseTask,
} = require('./lib/taskParser');
const {
  postTaskAndCollectBids,
  approveAndFundEscrow,
  getWalletFundingStatus,
  sendHeartbeat,
  MarketplaceError,
  MODE,
} = require('./lib/marketplaceClient');
const { rankBids, explainTopChoice } = require('./lib/scoringEngine');
const { judgeBids } = require('./lib/relevance');
const { getA2aReadiness } = require('./lib/a2aClient');
const { ensureWorkingProvider } = require('./lib/providerFallback');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory task store (fine for a hackathon demo; swap for a DB later)
const tasks = new Map();

function sendError(res, err, fallbackStatus = 500) {
  const isMarket = err instanceof MarketplaceError;
  const code = isMarket ? err.code : 'INTERNAL_ERROR';
  const status =
    code === 'INSUFFICIENT_FUNDS' ? 402 :
    code === 'CONFIG_ERROR' || code === 'INVALID_BID' ? 400 :
    fallbackStatus;

  res.status(status).json({
    error: err.message,
    code,
    funding: isMarket ? err.funding : undefined,
  });
}

// GET /api/status -- sanity check + live wallet preflight
app.get('/api/status', async (req, res) => {
  // Reported independently of funding and heartbeat: a green heartbeat says
  // nothing about whether inbound job invites can actually be received.
  const a2a =
    MODE === 'live'
      ? await getA2aReadiness().catch((err) => ({
          ready: false,
          message: `Readiness check failed: ${err.message}`,
        }))
      : { ready: true, message: 'Mock mode — no A2A channel required.' };

  const status = {
    ok: true,
    marketplace_mode: MODE,
    groq_configured: Boolean(process.env.GROQ_API_KEY),
    agent_id_configured: Boolean(process.env.OKX_AGENT_ID),
    asp_agent_id_configured: Boolean(process.env.OKX_ASP_AGENT_ID),
    can_receive_jobs: a2a.ready,
    a2a,
  };

  try {
    status.funding = await getWalletFundingStatus({ requiredUsdt: 0 });
  } catch (err) {
    status.funding = { mode: MODE, ready: MODE === 'mock', message: err.message };
  }

  res.json(status);
});

// GET /api/funding?amount=1 — re-check USDT for a bid amount
app.get('/api/funding', async (req, res) => {
  try {
    const amount = Number(req.query.amount || 0);
    const funding = await getWalletFundingStatus({ requiredUsdt: amount });
    res.json(funding);
  } catch (err) {
    sendError(res, err);
  }
});

// POST /api/tasks -- parse plain-language input, post to marketplace, collect + rank bids
app.post('/api/tasks', async (req, res) => {
  try {
    const { input } = req.body;
    if (!input || !input.trim()) {
      return res.status(400).json({ error: 'Missing "input" field with task description.' });
    }

    const task = await parseTask(input);

    if (input.toLowerCase().includes('budget')) {
      task.clarifying_questions = [];
    }

    if (task.clarifying_questions.length > 0) {
      return res.json({ task, needs_clarification: true, bids: [] });
    }

    const { task_id, bids } = await postTaskAndCollectBids(task);
    // asp-match returns plausible neighbours, not capability matches, and the
    // score only sees price/stars/ETA — on which the wrong kind of service
    // routinely wins. Judge scope before ranking. Groq is already required above
    // by parseTask, so this adds no dependency this route didn't already have.
    const judged = await judgeBids(task, bids);
    const ranked = rankBids(task, judged);
    const explanation = explainTopChoice(ranked, task);

    const localRefId = task_id || `local_${Date.now()}`;
    tasks.set(localRefId, { task, bids: ranked, status: 'bidding_complete' });

    // The recommendation is the best bid that can actually do the job — not
    // ranked[0], which is only the least-bad option when everything is off scope.
    // Null is a real answer here ("nothing suitable was found"); the UI leaves
    // Approve disabled rather than defaulting to the top row.
    const recommended = ranked.find((b) => !b.off_scope) || null;

    let funding = null;
    if (MODE === 'live' && recommended) {
      try {
        funding = await getWalletFundingStatus({
          requiredUsdt: Number(recommended.price_usdt) || 0,
        });
      } catch (_) {
        /* non-fatal for quote view */
      }
    }

    res.json({
      task_id: localRefId,
      task,
      bids: ranked,
      recommended_bid_id: recommended?.bid_id || null,
      explanation,
      funding,
    });
  } catch (err) {
    console.error(err);
    sendError(res, err);
  }
});

// POST /api/tasks/:taskId/approve -- approve a bid, fund escrow
app.post('/api/tasks/:taskId/approve', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { bidId } = req.body;
    if (!bidId) return res.status(400).json({ error: 'Missing "bidId" in request body.' });

    const record = tasks.get(taskId);
    if (!record) return res.status(404).json({ error: 'Unknown task_id.' });

    const chosenBid = record.bids.find((b) => b.bid_id === bidId);
    if (!chosenBid) return res.status(400).json({ error: 'Unknown bidId for this task.' });

    const result = await approveAndFundEscrow(taskId, bidId, record.task, chosenBid);
    record.status = 'escrow_funded';
    record.approved_bid_id = bidId;
    record.job_id = result.task_id;

    res.json(result);
  } catch (err) {
    console.error(err);
    sendError(res, err);
  }
});

// GET /api/tasks/:taskId -- fetch current state
app.get('/api/tasks/:taskId', (req, res) => {
  const record = tasks.get(req.params.taskId);
  if (!record) return res.status(404).json({ error: 'Unknown task_id.' });
  res.json(record);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Quote Runner backend running on http://localhost:${PORT}`);
  console.log(`Marketplace mode: ${MODE}`);

  // Periodic agent heartbeat to keep status "online" on OKX.AI
  async function triggerHeartbeat() {
    try {
      console.log('Sending agent heartbeat...');
      await sendHeartbeat();
      console.log('Agent heartbeat sent successfully.');
    } catch (err) {
      console.error('Failed to send heartbeat:', err.message);
    }
  }

  // Send immediately on start, then every 2 minutes
  triggerHeartbeat();
  setInterval(triggerHeartbeat, 2 * 60 * 1000);

  // Inbound job invites are delivered as system events by the okx-a2a daemon,
  // which dispatches them to the configured AI runtime. That runtime calls
  // `onchainos agent next-action`, which owns the apply/deliver state machine.
  //
  // This server does not poll for jobs and does not call `apply` itself:
  // `agent tasks` only lists jobs we already hold, and `apply` outside the
  // JobAspSelected playbook corrupts task state. All this process does is
  // assert the delivery channel is actually up, and say so loudly if not.
  async function checkA2aReadiness() {
    if (MODE !== 'live') return;
    try {
      const readiness = await getA2aReadiness();
      if (readiness.ready) {
        console.log(`[A2A] ${readiness.message}`);
        return;
      }
      console.error(`[A2A] NOT READY — job invites will be missed: ${readiness.message}`);

      // Secondary net to the standalone `npm run watchdog`: if the bound AI
      // provider is the reason we're not ready, try to fail over to a working
      // one. The watchdog reacts to dispatch failures; this reacts to the
      // provider being unusable even before a job arrives.
      if (readiness.ai_provider_logged_in === false) {
        const report = await ensureWorkingProvider();
        console.error(`[A2A] provider failover: ${report.message || report.action}`);
      }
    } catch (err) {
      console.error('[A2A] Readiness check failed:', err.message);
    }
  }

  checkA2aReadiness();
  setInterval(checkA2aReadiness, 5 * 60 * 1000);
});
