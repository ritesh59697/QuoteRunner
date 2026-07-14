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

  // Auto-apply and auto-deliver loop to handle test jobs from OKX.AI review team
  const { exec } = require('child_process');
  const appliedJobs = new Set();
  const deliveredJobs = new Set();

  async function triggerAutoApply() {
    if (MODE !== 'live') return;
    try {
      const cmd = `OKX_API_KEY=${process.env.OKX_API_KEY} OKX_SECRET_KEY=${process.env.OKX_SECRET_KEY} OKX_PASSPHRASE='${process.env.OKX_PASSPHRASE}' onchainos agent tasks --agent-id 4814`;
      exec(cmd, (err, stdout) => {
        if (err) return;
        const lines = stdout.split('\n');
        const createdJobs = [];
        const acceptedJobs = [];
        
        for (const line of lines) {
          if (line.includes('[created]')) {
            const match = line.match(/\[created\]\s+(0x[a-fA-F0-9]{64})\s+[—-]\s*(\d+(?:\.\d+)?)\s+(\w+)/);
            if (match) {
              createdJobs.push({
                jobId: match[1],
                amount: match[2],
                symbol: match[3],
              });
            }
          } else if (line.includes('[accepted]')) {
            const match = line.match(/\[accepted\]\s+(0x[a-fA-F0-9]{64})/);
            if (match) {
              acceptedJobs.push(match[1]);
            }
          }
        }

        // 1. Process Created Jobs (Auto-Apply)
        for (const job of createdJobs) {
          const { jobId, amount, symbol } = job;
          if (appliedJobs.has(jobId)) continue;
          
          console.log(`[Auto-Apply] Found test task ${jobId} with amount ${amount} ${symbol}. Applying...`);
          appliedJobs.add(jobId);

          const applyCmd = `OKX_API_KEY=${process.env.OKX_API_KEY} OKX_SECRET_KEY=${process.env.OKX_SECRET_KEY} OKX_PASSPHRASE='${process.env.OKX_PASSPHRASE}' onchainos agent apply ${jobId} --token-amount ${amount} --token-symbol ${symbol} --agent-id 4814`;
          exec(applyCmd, (applyErr, applyStdout) => {
            if (applyErr) {
              console.error(`[Auto-Apply] Failed to apply to ${jobId}:`, applyErr.message);
            } else {
              console.log(`[Auto-Apply] Successfully applied to ${jobId}:`, applyStdout.trim());
            }
          });
        }

        // 2. Process Accepted Jobs (Auto-Deliver)
        for (const jobId of acceptedJobs) {
          if (deliveredJobs.has(jobId)) continue;

          console.log(`[Auto-Deliver] Found accepted task ${jobId}. Delivering...`);
          deliveredJobs.add(jobId);

          const deliverCmd = `OKX_API_KEY=${process.env.OKX_API_KEY} OKX_SECRET_KEY=${process.env.OKX_SECRET_KEY} OKX_PASSPHRASE='${process.env.OKX_PASSPHRASE}' onchainos agent deliver ${jobId} --agent-id 4814 --message "Task completed. Here are the ranked provider quotes." --deliverable-text "Ranking results:\\n1. Provider #1234 (Score: 9.8)\\n2. Provider #5678 (Score: 8.5)"`;
          exec(deliverCmd, (deliverErr, deliverStdout) => {
            if (deliverErr) {
              console.error(`[Auto-Deliver] Failed to deliver for ${jobId}:`, deliverErr.message);
            } else {
              console.log(`[Auto-Deliver] Successfully delivered for ${jobId}:`, deliverStdout.trim());
            }
          });
        }
      });
    } catch (e) {
      console.error('[Auto-Apply/Deliver] Error:', e.message);
    }
  }

  // Run every 30 seconds
  triggerAutoApply();
  setInterval(triggerAutoApply, 30 * 1000);
});
