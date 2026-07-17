/**
 * relevance.js
 * Judges whether a matched marketplace service can actually DO the buyer's task.
 *
 * Why this exists: asp-match is a loose recommender — it returns plausible-
 * looking neighbours, not capability matches. Observed 2026-07-17 on job
 * 0xe51506 ("find me a logo designer", 20 USDT): asp-match returned 9 services,
 * only 3 of which design anything. scoringEngine weights price/reputation/speed
 * and has no notion of relevance, so "Crypto Doc Localization" — cheap, 5★, and
 * completely unable to draw a logo — scored 0.997 and took the top
 * recommendation slot. The deliverable read "Chose Crypto Doc Localization over
 * Full brand kit — 40% cheaper."
 *
 * Relevance is a CONSTRAINT, not a preference. There is no price at which a
 * localization service becomes the right answer for a logo job, so this never
 * feeds a weight — it feeds the `off_scope` flag that bars a bid from the top
 * spot (see scoringEngine.rankBids), exactly like `over_budget`.
 *
 * The judgement is semantic ("does 'Crypto Doc Localization' design logos?"),
 * so it needs the LLM. Groq is already on this path — rank-for-job calls
 * taskParser for the budget before it ever gets here — so this adds no new
 * dependency, only one more call.
 */

const fetch = require('node-fetch');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM_PROMPT = `You are a capability matcher for an AI agent marketplace.

Given a buyer's task and a numbered list of candidate services, decide for EACH
candidate whether that service can actually perform the task's core deliverable.

Return ONLY valid JSON, no markdown fences, no preamble, matching this shape:
{
  "judgements": [
    { "index": 0, "relevant": true, "reason": "short phrase, max 8 words" }
  ]
}

Rules:
- Judge CAPABILITY, not price, reputation, or speed. Those are scored elsewhere.
- relevant=true only if the service's own name/description shows it produces the
  thing the task asks for. A logo task needs a service that designs logos or
  brand assets; translation, localization, auditing, marketing copy, research,
  and directory services are NOT logo designers however good they look.
- Adjacent-but-different is NOT relevant. "Website copy" does not design logos.
  "Brand guidelines" does, because it produces brand/visual assets.
- A generalist service that plausibly covers the task's category IS relevant.
- When genuinely torn, answer false. A wrongly-included service can be
  recommended to the buyer; a wrongly-excluded one is still shown to them.
- reason must state the capability basis, e.g. "designs brand assets" or
  "localizes documents, not design".
- Return exactly one judgement per candidate index. Omit none.`;

/**
 * Ask the LLM which candidates can do the task.
 *
 * @param {object} task - structured task (uses .title and .description)
 * @param {Array} bids - bids from marketplaceClient (uses .agent_name, .note)
 * @returns {Promise<Map<number, {relevant: boolean, reason: string}>>} keyed by
 *          index into `bids`. Indexes the model omits are simply absent —
 *          callers treat absent as off-scope (see judgeBids).
 * @throws if GROQ_API_KEY is unset or Groq returns nothing parseable. Callers
 *         must not swallow this: an unjudged shortlist is the exact input that
 *         produced the Crypto Doc Localization recommendation.
 */
async function judgeRelevance(task, bids) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not set. Add it to your .env file.');
  }

  const model = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

  // One call for the whole shortlist, not one per bid: cheaper, and it lets the
  // model see the candidates side by side, which is how "adjacent but different"
  // becomes obvious.
  const candidates = bids
    .map((b, i) => {
      const desc = String(b.note || '').trim().slice(0, 300);
      return `${i}. ${b.agent_name}${desc ? ` — ${desc}` : ''}`;
    })
    .join('\n');

  const userContent =
    `TASK TITLE: ${task.title}\n` +
    `TASK DESCRIPTION: ${task.description}\n\n` +
    `CANDIDATES:\n${candidates}`;

  const response = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) {
    throw new Error('Groq API returned no content for relevance judgement');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse relevance output as JSON: ${raw}`);
  }

  const judgements = Array.isArray(parsed.judgements) ? parsed.judgements : null;
  if (!judgements) {
    throw new Error(`Relevance output has no judgements array: ${raw}`);
  }

  const byIndex = new Map();
  judgements.forEach((j) => {
    const i = Number(j.index);
    if (!Number.isInteger(i) || i < 0 || i >= bids.length) return;
    byIndex.set(i, {
      relevant: j.relevant === true,
      reason: String(j.reason || '').trim(),
    });
  });
  return byIndex;
}

/**
 * Annotate bids with `off_scope` + `scope_reason`.
 *
 * Absent judgement => off_scope. The model is asked for one per candidate, so a
 * gap means it declined or drifted; demoting is the safe reading, since the bid
 * is still listed for the buyer either way. Only an affirmative `relevant:true`
 * earns eligibility for the recommendation slot.
 *
 * @throws whatever judgeRelevance throws — an unjudged shortlist must not
 *         silently rank as if every candidate were capable.
 */
async function judgeBids(task, bids) {
  if (!bids || bids.length === 0) return [];

  const byIndex = await judgeRelevance(task, bids);

  return bids.map((bid, i) => {
    const j = byIndex.get(i);
    return {
      ...bid,
      off_scope: !(j && j.relevant),
      scope_reason: j ? j.reason : 'not judged capable of this task',
    };
  });
}

module.exports = { judgeRelevance, judgeBids };
