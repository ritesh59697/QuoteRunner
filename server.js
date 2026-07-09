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
  MarketplaceError,
  MODE,
} = require('./lib/marketplaceClient');
const { rankBids, explainTopChoice } = require('./lib/scoringEngine');

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
  try {
    const funding = await getWalletFundingStatus({ requiredUsdt: 0 });
    res.json({
      ok: true,
      marketplace_mode: MODE,
      groq_configured: Boolean(process.env.GROQ_API_KEY),
      agent_id_configured: Boolean(process.env.OKX_AGENT_ID),
      funding,
    });
  } catch (err) {
    res.json({
      ok: true,
      marketplace_mode: MODE,
      groq_configured: Boolean(process.env.GROQ_API_KEY),
      agent_id_configured: Boolean(process.env.OKX_AGENT_ID),
      funding: {
        mode: MODE,
        ready: MODE === 'mock',
        message: err.message,
      },
    });
  }
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

    if (task.clarifying_questions.length > 0) {
      return res.json({ task, needs_clarification: true, bids: [] });
    }

    const { task_id, bids } = await postTaskAndCollectBids(task);
    const ranked = rankBids(task, bids);
    const explanation = explainTopChoice(ranked, task);

    const localRefId = task_id || `local_${Date.now()}`;
    tasks.set(localRefId, { task, bids: ranked, status: 'bidding_complete' });

    let funding = null;
    if (MODE === 'live' && ranked[0]) {
      try {
        funding = await getWalletFundingStatus({
          requiredUsdt: Number(ranked[0].price_usdt) || 0,
        });
      } catch (_) {
        /* non-fatal for quote view */
      }
    }

    res.json({
      task_id: localRefId,
      task,
      bids: ranked,
      recommended_bid_id: ranked[0]?.bid_id || null,
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
});
