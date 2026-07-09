/**
 * taskParser.js
 * Turns a plain-language task description into a structured task object
 * that can be posted to the OKX.AI Task Marketplace.
 *
 * Uses Groq's OpenAI-compatible chat completions endpoint (free-tier friendly,
 * matches Ritesh's existing Groq/Llama 3.1 setup).
 */

const fetch = require('node-fetch');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM_PROMPT = `You are a task-structuring engine for an AI agent marketplace.
Given a plain-language request from a user, extract a structured task object.

Return ONLY valid JSON, no markdown fences, no preamble, matching this exact shape:
{
  "title": "short 5-8 word title",
  "description": "clear 1-3 sentence description of the work needed",
  "category": "one of: design, writing, development, translation, research, marketing, other",
  "budget_usdt": number (best guess if not stated, reasonable market rate),
  "deadline_hours": number (hours from now; best guess if not stated, e.g. 48),
  "clarifying_questions": [array of 0-2 short questions ONLY if the request is too vague to price/scope confidently]
}

Rules:
- If the user gives a budget, use it exactly.
- If the user gives a deadline like "2 days", convert to hours (48).
- Keep description factual, no fluff.
- Do not invent unrealistic budgets.`;

async function parseTask(userInput) {
  if (!userInput || !userInput.trim()) {
    throw new Error('userInput is required');
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not set. Add it to your .env file.');
  }

  const model = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

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
        { role: 'user', content: userInput },
      ],
      temperature: 0.2,
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
    throw new Error('Groq API returned no content');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse LLM output as JSON: ${raw}`);
  }

  // Defensive defaults
  return {
    title: parsed.title || 'Untitled task',
    description: parsed.description || userInput,
    category: parsed.category || 'other',
    budget_usdt: Number(parsed.budget_usdt) || 20,
    deadline_hours: Number(parsed.deadline_hours) || 48,
    clarifying_questions: Array.isArray(parsed.clarifying_questions)
      ? parsed.clarifying_questions
      : [],
    raw_input: userInput,
    created_at: new Date().toISOString(),
  };
}

module.exports = { parseTask };
