require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { parseTask } = require('./lib/taskParser');
const { postTaskAndCollectBids, approveAndFundEscrow, MODE } = require('./lib/marketplaceClient');
const { rankBids, explainTopChoice } = require('./lib/scoringEngine');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory task store (fine for a hackathon demo; swap for a DB later)
const tasks = new Map();

// GET /api/status -- quick sanity check for demo prep
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    marketplace_mode: MODE,
    groq_configured: Boolean(process.env.GROQ_API_KEY),
  });
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
      // Still return the best-guess task so the UI can show it, but flag for clarification
      return res.json({ task, needs_clarification: true, bids: [] });
    }

    const { task_id, bids } = await postTaskAndCollectBids(task);
    const ranked = rankBids(task, bids);
    const explanation = explainTopChoice(ranked, task);

    // In live mode, task_id is null here — asp-match is a pre-publish
    // discovery step; the real on-chain jobId only exists after create-task
    // runs during approval. Use a local reference id to key the in-memory
    // store either way so the UI has something stable to refer back to.
    const localRefId = task_id || `local_${Date.now()}`;
    tasks.set(localRefId, { task, bids: ranked, status: 'bidding_complete' });

    res.json({
      task_id: localRefId,
      task,
      bids: ranked,
      recommended_bid_id: ranked[0]?.bid_id || null,
      explanation,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
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
    const result = await approveAndFundEscrow(taskId, bidId, record.task, chosenBid);
    record.status = 'escrow_funded';
    record.approved_bid_id = bidId;

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tasks/:taskId -- fetch current state (for polling/refresh)
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
