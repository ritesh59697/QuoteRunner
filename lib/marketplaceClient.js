/**
 * marketplaceClient.js
 * Abstraction over the OKX.AI Task Marketplace.
 *
 * MOCK MODE (default): simulated bids for demos without OKX credentials.
 * LIVE MODE: shells out to `onchainos` CLI (asp-match → create-task → confirm-accept).
 *
 * Escrow funding requires USDT on XLayer in the agentic wallet.
 */

const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const MODE = process.env.MARKETPLACE_MODE || 'mock';
const ONCHAINOS_BIN = process.env.ONCHAINOS_BIN || 'onchainos';
const AGENT_ID = process.env.OKX_AGENT_ID;
const CLI_TIMEOUT_MS = Number(process.env.ONCHAINOS_TIMEOUT_MS || 90000);

function cliEnv() {
  return {
    ...process.env,
    OKX_API_KEY: process.env.OKX_API_KEY,
    OKX_SECRET_KEY: process.env.OKX_SECRET_KEY,
    OKX_PASSPHRASE: process.env.OKX_PASSPHRASE,
  };
}

/**
 * Extract a human-readable message from onchainos stdout/stderr.
 * Prefer JSON { ok:false, error } which the CLI often prints on failure.
 */
function extractCliErrorMessage(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;

  // Prefer last JSON object (CLI sometimes prefixes logs)
  const matches = text.match(/\{[\s\S]*?\}(?=\s*$|\s*\{)/g) || text.match(/\{[\s\S]*\}/g);
  if (matches) {
    for (let i = matches.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(matches[i]);
        if (obj && (obj.error || obj.message || obj.msg)) {
          return String(obj.error || obj.message || obj.msg).trim();
        }
        if (obj && obj.ok === false && obj.data) {
          return typeof obj.data === 'string' ? obj.data : JSON.stringify(obj.data);
        }
      } catch (_) {
        /* keep trying */
      }
    }
  }

  // First meaningful line
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('Usage:') && !l.startsWith('error: unrecognized'));
  return line || text.slice(0, 500);
}

function friendlyFundingHint(msg) {
  if (!msg) return msg;
  const lower = msg.toLowerCase();
  if (
    lower.includes('usdt balance') ||
    lower.includes('balance not found') ||
    lower.includes('insufficient')
  ) {
    return (
      msg +
      '\n\nFund USDT on XLayer to this agentic wallet, then try Approve again. ' +
      'For demos without funds, set MARKETPLACE_MODE=mock in .env.'
    );
  }
  return msg;
}

class MarketplaceError extends Error {
  constructor(message, { code = 'MARKETPLACE_ERROR', funding = null, details = null } = {}) {
    super(message);
    this.name = 'MarketplaceError';
    this.code = code;
    this.funding = funding;
    this.details = details;
  }
}

async function runOnchainos(args, { timeout = CLI_TIMEOUT_MS } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(ONCHAINOS_BIN, args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: cliEnv(),
    });
    // Some CLI paths print ok:false with exit 0 — treat as failure
    const combined = [stdout, stderr].filter(Boolean).join('\n');
    try {
      const json = extractJsonLoose(combined);
      if (json && json.ok === false) {
        const msg = friendlyFundingHint(
          extractCliErrorMessage(combined) || 'onchainos command failed'
        );
        throw new MarketplaceError(msg, {
          code: isFundingError(msg) ? 'INSUFFICIENT_FUNDS' : 'CLI_ERROR',
          details: { args, raw: combined.slice(0, 2000) },
        });
      }
    } catch (e) {
      if (e instanceof MarketplaceError) throw e;
    }
    return stdout || '';
  } catch (err) {
    if (err instanceof MarketplaceError) throw err;
    const raw = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
    const parsed = extractCliErrorMessage(raw);
    const msg = friendlyFundingHint(
      parsed || `onchainos failed (${args.join(' ')}): ${err.message}`
    );
    throw new MarketplaceError(msg, {
      code: isFundingError(msg) ? 'INSUFFICIENT_FUNDS' : 'CLI_ERROR',
      details: { args, raw: raw.slice(0, 2000) },
    });
  }
}

function isFundingError(msg) {
  const lower = String(msg || '').toLowerCase();
  return (
    lower.includes('usdt balance') ||
    lower.includes('balance not found') ||
    lower.includes('insufficient') ||
    lower.includes('fund your wallet')
  );
}

function extractJsonLoose(text) {
  if (!text) return null;
  const match = String(text).match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (_) {
    return null;
  }
}

function extractJson(stdout) {
  const match = String(stdout).match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!match) throw new Error(`No JSON found in onchainos output: ${stdout}`);
  return JSON.parse(match[0]);
}

/**
 * Read XLayer USDT balance + deposit address for preflight UI.
 */
async function getWalletFundingStatus({ requiredUsdt = 0 } = {}) {
  if (MODE === 'mock') {
    return {
      mode: 'mock',
      ready: true,
      logged_in: true,
      usdt_xlayer: null,
      required_usdt: requiredUsdt,
      address: null,
      total_value_usd: null,
      message: 'Mock mode — escrow is simulated; no USDT required.',
    };
  }

  let address = null;
  let usdt = 0;
  let totalValueUsd = null;
  let loggedIn = false;

  try {
    const statusOut = await runOnchainos(['wallet', 'status'], { timeout: 20000 });
    const statusJson = extractJsonLoose(statusOut);
    loggedIn = Boolean(statusJson?.data?.loggedIn ?? statusJson?.loggedIn);
  } catch (_) {
    loggedIn = false;
  }

  try {
    const addrOut = await runOnchainos(['wallet', 'addresses'], { timeout: 20000 });
    const addrJson = extractJsonLoose(addrOut);
    const data = addrJson?.data || addrJson;
    // Prefer EVM address (XLayer uses same EVM key)
    if (data?.evm?.[0]?.address) address = data.evm[0].address;
    else if (data?.evmAddress) address = data.evmAddress;
  } catch (_) {
    /* optional */
  }

  try {
    const balOut = await runOnchainos(['wallet', 'balance', '--chain', 'xlayer'], {
      timeout: 30000,
    });
    const balJson = extractJsonLoose(balOut);
    const data = balJson?.data || balJson || {};
    totalValueUsd = data.totalValueUsd != null ? String(data.totalValueUsd) : null;
    if (data.evmAddress && !address) address = data.evmAddress;

    usdt = sumUsdtFromBalancePayload(data);
  } catch (err) {
    return {
      mode: 'live',
      ready: false,
      logged_in: loggedIn,
      usdt_xlayer: 0,
      required_usdt: requiredUsdt,
      address,
      total_value_usd: totalValueUsd,
      message:
        'Could not read XLayer wallet balance. Is the onchainos wallet logged in? ' +
        (err.message || ''),
      error: err.message,
    };
  }

  const need = Number(requiredUsdt) || 0;
  const ready = usdt + 1e-9 >= need && need >= 0;
  // If required is 0, still flag empty wallet so user knows before approve
  const emptyWallet = usdt <= 0;
  const effectiveReady = need > 0 ? ready : !emptyWallet ? true : false;

  let message;
  if (emptyWallet) {
    message =
      `No USDT on XLayer${address ? ` (${shortAddr(address)})` : ''}. ` +
      'Escrow needs USDT on XLayer before Approve. Bridge/swap/withdraw USDT to this address on the XLayer network.';
  } else if (need > 0 && !ready) {
    message =
      `Need ${need} USDT on XLayer; wallet has ~${formatAmt(usdt)} USDT` +
      (address ? ` at ${shortAddr(address)}` : '') +
      '. Fund the difference, then retry.';
  } else {
    message = `XLayer wallet ready · ~${formatAmt(usdt)} USDT` +
      (address ? ` · ${shortAddr(address)}` : '');
  }

  return {
    mode: 'live',
    ready: need > 0 ? ready : !emptyWallet,
    logged_in: loggedIn,
    usdt_xlayer: usdt,
    required_usdt: need,
    address,
    total_value_usd: totalValueUsd,
    message,
  };
}

function sumUsdtFromBalancePayload(data) {
  let total = 0;
  const details = data.details || [];
  for (const block of details) {
    const assets = block.tokenAssets || block.tokens || block.assets || [];
    for (const t of assets) {
      const sym = String(t.symbol || t.tokenSymbol || t.coin || '').toUpperCase();
      if (sym !== 'USDT' && sym !== 'USD₮') continue;
      const bal = Number(
        t.balance ?? t.amount ?? t.tokenAmount ?? t.availableBalance ?? t.holding ?? 0
      );
      if (!Number.isNaN(bal)) total += bal;
    }
  }
  // Some payloads flatten USDT at top level
  if (total === 0 && data.usdt != null) total = Number(data.usdt) || 0;
  return total;
}

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatAmt(n) {
  if (n == null || Number.isNaN(n)) return '0';
  if (n === 0) return '0';
  if (n < 0.01) return n.toFixed(4);
  return (Math.round(n * 100) / 100).toString();
}

async function assertCanFundEscrow(amountUsdt) {
  const funding = await getWalletFundingStatus({ requiredUsdt: amountUsdt });
  if (MODE === 'mock') return funding;

  if (!funding.ready) {
    throw new MarketplaceError(funding.message, {
      code: 'INSUFFICIENT_FUNDS',
      funding,
    });
  }
  return funding;
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
    console.error('Failed to fetch reputations for agents:', err.message);
    return {};
  }
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

  const pool = relevantAgents.length >= 3 ? relevantAgents : MOCK_AGENT_POOL;
  const numBids = Math.min(pool.length, 3 + Math.floor(Math.random() * 3));

  const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, numBids);

  return shuffled.map((agent) => {
    const priceVariance = randomBetween(-0.25, 0.15);
    const price = Math.max(1, Math.round(task.budget_usdt * (1 + priceVariance)));
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

async function postTaskAndCollectBids(task) {
  if (MODE === 'mock') {
    await new Promise((r) => setTimeout(r, 400));
    return {
      task_id: `task_mock_${Date.now()}`,
      mode: 'mock',
      bids: generateMockBids(task),
    };
  }

  if (!AGENT_ID) {
    throw new MarketplaceError(
      'MARKETPLACE_MODE=live but OKX_AGENT_ID is not set. Register a User-role agent ' +
        '(onchainos agent create --role user) and set OKX_AGENT_ID in .env.',
      { code: 'CONFIG_ERROR' }
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
  const agentList =
    matches.data?.recommendations ||
    matches.data?.agentList ||
    matches.recommendations ||
    matches.agentList ||
    [];

  const providerIds = [...new Set(agentList.map((a) => a.providerAgentId).filter(Boolean))];
  const reputationMap = await getAgentReputations(providerIds);

  const bids = [];
  agentList.forEach((agent) => {
    const services = agent.services || [];
    services.forEach((service) => {
      let reputation = reputationMap[agent.providerAgentId];
      if (reputation === undefined || reputation === null) {
        reputation = agent.securityRate ? Number(agent.securityRate) : 4.0;
      }

      bids.push({
        bid_id: service.serviceId || `service_${bids.length}`,
        agent_id: agent.providerAgentId,
        agent_name: service.serviceName || agent.name || `ASP ${agent.providerAgentId}`,
        reputation,
        price_usdt: Number(
          service.feeAmount !== undefined && service.feeAmount !== null
            ? service.feeAmount
            : task.budget_usdt
        ),
        eta_hours: Number(task.deadline_hours),
        note: service.serviceDescription || '',
        _raw: service,
      });
    });
  });

  // Inject our own ASP 4814 (Quote Comparison & Ranking) so they can test live on-chain interactions for 0 USDT
  bids.push({
    bid_id: '31684',
    agent_id: '4814',
    agent_name: 'Quote Comparison & Ranking',
    reputation: 5.0,
    price_usdt: 0.0,
    eta_hours: Number(task.deadline_hours),
    note: 'Compare and rank bids for your task. Returns the top service provider on the marketplace with a transparent explanation.',
    _raw: {
      serviceId: '31684',
      serviceName: 'Quote Comparison & Ranking',
      serviceType: 'A2A',
      contractAddress: '0x779ded0c9e1022225f8e0630b35a9b54be713736',
      endpoint: null,
      fee: '0',
      feeAmount: 0,
      feeToken: '0x779ded0c9e1022225f8e0630b35a9b54be713736'
    }
  });

  return { task_id: null, mode: 'live', bids };
}

/**
 * Approve a bid and trigger escrow funding.
 * Live path: balance preflight → create-task → confirm-accept.
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

  if (!AGENT_ID) {
    throw new MarketplaceError('MARKETPLACE_MODE=live but OKX_AGENT_ID is not set.', {
      code: 'CONFIG_ERROR',
    });
  }
  if (!chosenBid || !chosenBid._raw) {
    throw new MarketplaceError(
      'Missing matched-service data for the chosen bid — cannot create-task.',
      { code: 'INVALID_BID' }
    );
  }

  const amount = Number(chosenBid.price_usdt) || 0;
  // Fail fast before creating an on-chain job that can't be funded
  await assertCanFundEscrow(amount);

  const m = chosenBid._raw;

  const createArgs = [
    'agent', 'create-task',
    '--title', task.title.slice(0, 30),
    '--description', task.description,
    '--description-summary', task.description.slice(0, 200),
    '--budget', String(chosenBid.price_usdt),
    '--max-budget', String(Math.max(task.budget_usdt, chosenBid.price_usdt)),
    '--currency', 'USDT',
    '--provider', String(chosenBid.agent_id),
    '--service-id', String(chosenBid.bid_id),
    '--service-params', task.description,
    '--service-token-address', m.feeToken || m.serviceTokenAddress || '',
    '--service-token-amount', String(chosenBid.price_usdt),
    '--visibility', '1',
    '--payment-mode', 'escrow',
  ];

  // --agent-id is accepted by some CLI builds for multi-agent wallets
  if (AGENT_ID) {
    createArgs.push('--agent-id', String(AGENT_ID));
  }

  const createOut = await runOnchainos(createArgs);

  let jobId = null;
  let createTxHash = null;
  try {
    const created = extractJsonLoose(createOut) || {};
    jobId = created.jobId || created.job_id || created.data?.jobId || created.data?.job_id;
    createTxHash = created.txHash || created.tx_hash || created.data?.txHash || created.data?.tx_hash;
  } catch (_) {
    /* fall through to regex */
  }
  if (!jobId) {
    const jobIdMatch =
      createOut.match(/jobId:\s*([0-9a-fxA-FX]+)/i) ||
      createOut.match(/jobId\s*=\s*([0-9a-fxA-FX]+)/i);
    const txHashMatch =
      createOut.match(/txHash:\s*([0-9a-fxA-FX]+)/i) ||
      createOut.match(/tx_hash:\s*([0-9a-fxA-FX]+)/i);
    jobId = jobIdMatch ? jobIdMatch[1] : null;
    createTxHash = txHashMatch ? txHashMatch[1] : null;
  }

  if (!jobId) {
    throw new MarketplaceError(`create-task did not return a jobId:\n${createOut.slice(0, 800)}`, {
      code: 'CREATE_TASK_FAILED',
    });
  }

  // Ensure payment mode is set (CLI requires this before confirm-accept)
  try {
    await runOnchainos([
      'agent',
      'set-payment-mode',
      jobId,
      '--payment-mode',
      'escrow',
      '--token-symbol',
      'USDT',
      '--token-amount',
      String(chosenBid.price_usdt),
    ]);
  } catch (err) {
    // Already set at create-task is fine; only rethrow hard failures
    const msg = String(err.message || '');
    if (!/already|set|same/i.test(msg) && err.code === 'INSUFFICIENT_FUNDS') {
      throw err;
    }
    if (err.code === 'INSUFFICIENT_FUNDS') throw err;
    console.warn('set-payment-mode note:', msg);
  }

  let confirmOut;
  const maxRetries = 24; // 2 minutes (24 * 5s)
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`[Escrow] Attempting to fund escrow on-chain (attempt ${i + 1}/${maxRetries})...`);
      confirmOut = await runOnchainos(['agent', 'confirm-accept', jobId]);
      break; // Success!
    } catch (err) {
      if (i === maxRetries - 1) {
        throw err; // Out of retries, throw the final error
      }
      console.log(`[Escrow] Provider application not found on-chain yet (likely waiting for third-party agent daemon). Retrying in 5 seconds...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  let confirmed = {};
  try {
    confirmed = extractJson(confirmOut);
  } catch (_) {
    confirmed = extractJsonLoose(confirmOut) || { raw: confirmOut };
  }

  return {
    status: 'escrow_funded',
    mode: 'live',
    task_id: jobId,
    bid_id: bidId,
    escrow_tx:
      confirmed.txHash ||
      confirmed.tx_hash ||
      confirmed.data?.txHash ||
      confirmed.data?.tx_hash ||
      createTxHash,
    raw: confirmed,
  };
}

async function sendHeartbeat() {
  if (MODE === 'mock') {
    return { status: 'mock_heartbeat_sent' };
  }
  try {
    const out = await runOnchainos(['agent', 'heartbeat', '--chain-index', '196']);
    return { status: 'success', data: out };
  } catch (err) {
    console.error('Heartbeat error:', err.message);
    throw err;
  }
}

module.exports = {
  postTaskAndCollectBids,
  approveAndFundEscrow,
  getWalletFundingStatus,
  sendHeartbeat,
  MarketplaceError,
  MODE,
};
