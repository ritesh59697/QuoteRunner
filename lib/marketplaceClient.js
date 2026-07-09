/**
 * marketplaceClient.js
 * Abstraction over the OKX.AI Task Marketplace.
 *
 * MOCK MODE (default): returns realistic simulated bids so the full
 * parse -> post -> bid -> rank -> approve loop can be built and demoed
 * without any OKX credentials.
 *
 * LIVE MODE: confirmed against the real integration — OKX.AI's Task
 * Marketplace is NOT a plain REST API. It's driven through the `onchainos`
 * CLI (installed via `npx skills add okx/onchainos-skills`), which wraps an
 * on-chain event state machine (ERC-8004 agent identity + escrow/x402
 * payments on XLayer). Source: github.com/okx/onchainos-skills,
 * skills/okx-ai/references/task-cli-reference.md.
 *
 * Real commands this file shells out to in live mode:
 *   - `onchainos agent asp-match --task-desc "<desc>" --agent-id <id> --format json`
 *     -> matched ASP services: { serviceId, ServiceTitle, ServiceDescription,
 *        Price, symbol, providerAgentId, endpoint, serviceType }
 *     This is the real "collect bids" mechanism — a match/quote query
 *     against listed ASP services, not an open auction with live counter-bids.
 *   - `onchainos agent create-task --title <t> --description <d> --budget <b>
 *     --max-budget <b> --currency USDT --provider <agentId> --service-id <id>
 *     --service-params "<text>" --service-token-address <addr>
 *     --service-token-amount <amt> --visibility 1`
 *     -> publishes the task assigned to the chosen ASP, returns jobId
 *   - `onchainos agent confirm-accept <jobId>`
 *     -> confirms ASP acceptance and funds escrow
 *
 * PRECONDITIONS for live mode (not yet done — see README):
 *   1. `npx skills add okx/onchainos-skills` run once in this project
 *   2. `onchainos` CLI binary installed and on PATH (separate install step,
 *      see web3.okx.com/onchainos/dev-docs)
 *   3. OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE from the OKX Developer Portal
 *   4. A User-role agent identity registered on XLayer via
 *      `onchainos agent create --role user` (one-time; gives you OKX_AGENT_ID)
 *
 * Reputation is NOT returned by asp-match in what's documented so far — the
 * scoring engine currently falls back to a neutral default per bid in live
 * mode until a confirmed reputation lookup (`agent get-agents` /
 * identity-reputation) is wired in. Flagged with a TODO below.
 */

const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const MODE = process.env.MARKETPLACE_MODE || 'mock';
const ONCHAINOS_BIN = process.env.ONCHAINOS_BIN || 'onchainos';
const AGENT_ID = process.env.OKX_AGENT_ID;

async function runOnchainos(args) {
  try {
    const { stdout } = await execFileAsync(ONCHAINOS_BIN, args, {
      timeout: 30000,
      env: {
        ...process.env,
        OKX_API_KEY: process.env.OKX_API_KEY,
        OKX_SECRET_KEY: process.env.OKX_SECRET_KEY,
        OKX_PASSPHRASE: process.env.OKX_PASSPHRASE,
      }
    });
    return stdout;
  } catch (err) {
    throw new Error(
      `onchainos CLI call failed (${args.join(' ')}): ${err.stderr || err.message}`
    );
  }
}

async function getAgentReputations(agentIds) {
  if (!agentIds || agentIds.length === 0) return {};
  try {
    const stdout = await runOnchainos([
      'agent',
      'get-agents',
      '--agent-ids',
      agentIds.join(','),
    ]);
    const res = extractJson(stdout);
    const list = Array.isArray(res) ? res : res.data || [];
    const mapping = {};
    list.forEach((agent) => {
      const rate = agent.securityRate ? Number(agent.securityRate) : null;
      mapping[agent.agentId] = rate;
    });
    return mapping;
  } catch (err) {
    console.error(`Failed to fetch reputations for agents:`, err);
    return {};
  }
}

function extractJson(stdout) {
  // The CLI is built for conversational agent consumption and may print
  // human-readable text around the JSON payload; grab the JSON block.
  const match = stdout.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error(`No JSON found in onchainos output: ${stdout}`);
  return JSON.parse(match[0]);
}

// ---------- MOCK DATA ----------

const MOCK_AGENT_POOL = [
  { agent_id: 'agt_pixelforge', name: 'PixelForge Studio', reputation: 4.8, categories: ['design'] },
  { agent_id: 'agt_wordsmith', name: 'Wordsmith AI', reputation: 4.6, categories: ['writing', 'marketing'] },
  { agent_id: 'agt_codeburst', name: 'CodeBurst', reputation: 4.3, categories: ['development'] },
  { agent_id: 'agt_lingualink', name: 'LinguaLink', reputation: 4.9, categories: ['translation'] },
  { agent_id: 'agt_scoutresearch', name: 'ScoutResearch', reputation: 4.1, categories: ['research'] },
  { agent_id: 'agt_brandbrush', name: 'BrandBrush', reputation: 3.9, categories: ['design', 'marketing'] },
  { agent_id: 'agt_swiftdev', name: 'SwiftDev Collective', reputation: 4.5, categories: ['development'] },
  { agent_id: 'agt_generalist', name: 'GeneralAgent-7', reputation: 3.7, categories: ['other', 'design', 'writing', 'development', 'translation', 'research', 'marketing'] },
];

function randomBetween(min, max) {
  return Math.round((Math.random() * (max - min) + min) * 100) / 100;
}

function generateMockBids(task) {
  const relevantAgents = MOCK_AGENT_POOL.filter(
    (a) => a.categories.includes(task.category) || a.categories.includes('other')
  );

  // Ensure at least 3 bids even if category is niche
  const pool = relevantAgents.length >= 3 ? relevantAgents : MOCK_AGENT_POOL;
  const numBids = Math.min(pool.length, 3 + Math.floor(Math.random() * 3)); // 3-5 bids

  const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, numBids);

  return shuffled.map((agent) => {
    const priceVariance = randomBetween(-0.25, 0.15); // bids often undercut budget
    const price = Math.max(1, Math.round(task.budget_usdt * (1 + priceVariance)));
    const etaVariance = randomBetween(-0.3, 0.4);
    const etaHours = Math.max(1, Math.round(task.deadline_hours * (0.4 + Math.random() * 0.5)));

    return {
      bid_id: `bid_${agent.agent_id}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      agent_id: agent.agent_id,
      agent_name: agent.name,
      reputation: agent.reputation,
      price_usdt: price,
      eta_hours: etaHours,
      note: `${agent.name} can deliver "${task.title}" within scope.`,
    };
  });
}

// ---------- PUBLIC API ----------

/**
 * Post a structured task to the marketplace and collect bids.
 * @param {object} task - structured task from taskParser.parseTask()
 * @returns {Promise<{task_id: string, bids: Array}>}
 */
async function postTaskAndCollectBids(task) {
  if (MODE === 'mock') {
    await new Promise((r) => setTimeout(r, 400)); // simulate network latency
    return {
      task_id: `task_mock_${Date.now()}`,
      mode: 'mock',
      bids: generateMockBids(task),
    };
  }

  // ---- LIVE MODE ----
  if (!AGENT_ID) {
    throw new Error(
      'MARKETPLACE_MODE=live but OKX_AGENT_ID is not set. You need a User-role agent identity ' +
        'registered first (onchainos agent create --role user) — see README §Switching to live OKX.AI.'
    );
  }

  const stdout = await runOnchainos([
    'agent',
    'asp-match',
    '--task-desc',
    task.description,
    '--agent-id',
    AGENT_ID,
    '--format',
    'json',
  ]);

  const matches = extractJson(stdout);
  const agentList = matches.data?.recommendations || matches.data?.agentList || matches.recommendations || matches.agentList || [];

  // Extract unique provider agent IDs for batch reputation lookup
  const providerIds = [...new Set(agentList.map((a) => a.providerAgentId).filter(Boolean))];
  const reputationMap = await getAgentReputations(providerIds);

  const bids = [];
  agentList.forEach((agent) => {
    const services = agent.services || [];
    services.forEach((service) => {
      // Get reputation from batch lookup, or fallback to securityRate from asp-match, or fallback to 4.0
      let reputation = reputationMap[agent.providerAgentId];
      if (reputation === undefined || reputation === null) {
        reputation = agent.securityRate ? Number(agent.securityRate) : 4.0;
      }

      bids.push({
        bid_id: service.serviceId || `service_${bids.length}`,
        agent_id: agent.providerAgentId,
        agent_name: service.serviceName || agent.name || `ASP ${agent.providerAgentId}`,
        reputation: reputation,
        price_usdt: Number(service.feeAmount !== undefined && service.feeAmount !== null ? service.feeAmount : task.budget_usdt),
        eta_hours: Number(task.deadline_hours), // ETA not returned by CLI, use task deadline
        note: service.serviceDescription || '',
        _raw: service,
      });
    });
  });

  return { task_id: null, mode: 'live', bids };
}

/**
 * Approve a bid and trigger escrow funding via OKX Agent Payment Protocol.
 */
/**
 * @param {string} taskId - null in live mode until create-task runs (see note below)
 * @param {string} bidId - the chosen bid's bid_id (== serviceId in live mode)
 * @param {object} task - structured task (needed in live mode to actually call create-task)
 * @param {object} chosenBid - the full bid object from rankBids output (has ._raw match payload)
 */
async function approveAndFundEscrow(taskId, bidId, task, chosenBid) {
  if (MODE === 'mock') {
    await new Promise((r) => setTimeout(r, 500));
    return {
      status: 'escrow_funded',
      mode: 'mock',
      task_id: taskId,
      bid_id: bidId,
      escrow_tx: `mock_tx_${Date.now()}`,
    };
  }

  // ---- LIVE MODE ----
  if (!AGENT_ID) {
    throw new Error('MARKETPLACE_MODE=live but OKX_AGENT_ID is not set.');
  }
  if (!chosenBid || !chosenBid._raw) {
    throw new Error('Missing matched-service data for the chosen bid — cannot create-task.');
  }
  const m = chosenBid._raw;

  // Step 1: publish the task assigned to the chosen ASP + service
  const createArgs = [
    'agent', 'create-task',
    '--title', task.title.slice(0, 30), // CLI enforces max 30 chars
    '--description', task.description,
    '--description-summary', task.description.slice(0, 200),
    '--budget', String(chosenBid.price_usdt),
    '--max-budget', String(task.budget_usdt),
    '--currency', 'USDT',
    '--provider', chosenBid.agent_id,
    '--service-id', chosenBid.bid_id,
    '--service-params', task.description,
    '--service-token-address', m.feeToken || m.serviceTokenAddress || '',
    '--service-token-amount', String(chosenBid.price_usdt),
    '--visibility', '1',
    '--agent-id', AGENT_ID,
    '--payment-mode', 'escrow', // Required for private visibility with designated provider
  ];
  const createOut = await runOnchainos(createArgs);

  // Extract jobId and txHash (supporting both plain text and JSON outputs of create-task)
  let jobId = null;
  let createTxHash = null;
  try {
    const jsonMatch = createOut.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      const created = JSON.parse(jsonMatch[0]);
      jobId = created.jobId || created.job_id || created.data?.jobId || created.data?.job_id;
      createTxHash = created.txHash || created.tx_hash || created.data?.txHash || created.data?.tx_hash;
    }
  } catch (e) {
    // ignore json parse error
  }
  if (!jobId) {
    const jobIdMatch = createOut.match(/jobId:\s*([0-9a-fxA-FX]+)/i) || createOut.match(/jobId\s*=\s*([0-9a-fxA-FX]+)/i);
    const txHashMatch = createOut.match(/txHash:\s*([0-9a-fxA-FX]+)/i) || createOut.match(/tx_hash:\s*([0-9a-fxA-FX]+)/i);
    jobId = jobIdMatch ? jobIdMatch[1] : null;
    createTxHash = txHashMatch ? txHashMatch[1] : null;
  }

  if (!jobId) throw new Error(`create-task did not return a jobId: ${createOut}`);

  // Step 2: confirm ASP acceptance + fund escrow
  const confirmOut = await runOnchainos(['agent', 'confirm-accept', jobId]);
  const confirmed = extractJson(confirmOut);

  return {
    status: 'escrow_funded',
    mode: 'live',
    task_id: jobId,
    bid_id: bidId,
    escrow_tx: confirmed.txHash || confirmed.tx_hash || confirmed.data?.txHash || confirmed.data?.tx_hash || createTxHash,
    raw: confirmed,
  };
}

module.exports = { postTaskAndCollectBids, approveAndFundEscrow, MODE };
