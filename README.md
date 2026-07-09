# Quote Runner

Meta-agent for OKX.AI Genesis Hackathon. User describes a task in plain language →
Quote Runner posts it to the OKX.AI Task Marketplace → collects bids from live
Agent Service Providers → ranks them with a transparent scoring formula → user
approves → escrow funds via OKX Agent Payment Protocol.

## What's real vs. stubbed right now

| Piece | Status |
|---|---|
| Task parser (plain text → structured JSON) | **Real.** Calls Groq (Llama 3.1) directly. |
| Bid scoring engine (price/reputation/speed weighting + explanation) | **Real.** Pure logic, no external dependency, fully tested. |
| Marketplace client — mock mode | **Real & working.** Generates realistic simulated bids so you can build/demo the full loop today. |
| Marketplace client — live mode | **Confirmed integration path, not yet field-tested.** OKX.AI's Task Marketplace is NOT a plain REST API — it's driven through the `onchainos` CLI (source: `github.com/okx/onchainos-skills`, `skills/okx-ai/references/task-cli-reference.md`). `lib/marketplaceClient.js` now shells out to the real commands: `agent asp-match` (discovery/"bid" collection), `agent create-task` + `agent confirm-accept` (publish + fund escrow). Argument names and the create-task flow are confirmed from the docs; the exact JSON field casing in `asp-match`'s response, and whether it returns agent reputation, are **not yet confirmed** — flagged with TODOs in the code. |
| Escrow / Agent Payment Protocol | Real command sequence (`create-task` → `confirm-accept`), not yet run against a live task. |

## Important architecture note

`asp-match` is a **discovery/quote query** against already-listed ASP services — it returns matching services and their fee, not an open auction where independent agents place competing bids in real time. Your demo narrative ("Quote Runner collects live bids and ranks them") still holds — the ranking/scoring logic is real and is your differentiation — but internally it's closer to "smart quote comparison across matched providers" than a live auction. Worth knowing so you don't overstate the mechanism if a judge asks a technical question.

## Run it

```bash
npm install
cp .env.example .env
# edit .env and add your GROQ_API_KEY
npm start
```

Then open `http://localhost:3000`.

By default `MARKETPLACE_MODE=mock` in `.env` — this means task posting/bidding/escrow
all run against realistic simulated data, no OKX credentials needed. This is what you
should demo-test with right now.

## Switching to live OKX.AI

1. Get `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` from the OKX Developer Portal.
2. In this project directory, run: `npx skills add okx/onchainos-skills`
3. Install the `onchainos` CLI binary — see `web3.okx.com/onchainos/dev-docs`
   (the skills-add step installs skill markdown for agent context; the CLI
   binary itself is a separate install).
4. Register a User-role agent identity (one-time): `onchainos agent create --role user`
   — this gives you an agent ID. Put it in `.env` as `OKX_AGENT_ID`.
5. Set `MARKETPLACE_MODE=live` in `.env`.
6. **Before trusting it for a demo**, run the verification checklist below —
   the exact JSON shape `asp-match` returns hasn't been field-tested yet by
   either of us, and the parsing in `marketplaceClient.js` has fallback field
   names (`m.Price || m.price || m.feeAmount`) but may still need adjustment
   once you see real output.

**Important for demo day:** `asp-match` only surfaces ASPs that have already
listed a matching service — if the marketplace is thin in your task's category,
results may be sparse. Check a few days before recording; you may want a
backup category/task phrasing that's more likely to have listed services.

## How to check if this project is actually working

Go through these in order — each one isolates a different layer, so if
something breaks you'll know exactly where.

1. **Install & mock-mode smoke test**
   ```bash
   npm install
   cp .env.example .env   # add your real GROQ_API_KEY
   npm start
   ```
   Open `http://localhost:3000`. Type a task, hit "Post to Marketplace."
   You should see: a parsed task ledger → 3-5 ranked mock bids appear with a
   staggered animation → an explanation line → an "Approve" button that,
   when clicked, shows an escrow-funded confirmation with a mock tx id.
   If this doesn't work, the problem is either your Groq key (check
   `GET /api/status` shows `groq_configured: true`) or something broke in
   `server.js`/`public/index.html` — check the browser console and terminal
   output for the actual error.

2. **Confirm the Groq call independently**
   ```bash
   curl https://api.groq.com/openai/v1/chat/completions \
     -H "Authorization: Bearer $GROQ_API_KEY" -H "Content-Type: application/json" \
     -d '{"model":"llama-3.1-8b-instant","messages":[{"role":"user","content":"say hi"}]}'
   ```
   If this fails, it's a Groq account/key issue, not this app.

3. **CLI install sanity check (before touching this app's live mode)**
   ```bash
   npx skills add okx/onchainos-skills
   onchainos --version
   onchainos agent create --role user
   ```
   Do this in isolation first. If `onchainos agent create` fails or hangs,
   fix that before wiring `MARKETPLACE_MODE=live` — the app can't work around
   a broken CLI install.

4. **Raw asp-match test (confirms the real response shape)**
   ```bash
   onchainos agent asp-match --task-desc "design a logo for a coffee brand" \
     --agent-id <your OKX_AGENT_ID> --format json
   ```
   Read the actual JSON keys returned. Compare against the field-name
   fallbacks in `postTaskAndCollectBids()` in `lib/marketplaceClient.js`
   (`m.Price || m.price || m.feeAmount`, etc.) — adjust if the real keys
   differ. This is the single most likely place something needs a small fix.

5. **Live-mode end-to-end test in the app**
   Set `MARKETPLACE_MODE=live`, restart (`npm start`), repeat step 1's flow.
   Watch the terminal — `runOnchainos()` errors print the exact failing
   command and stderr, which tells you immediately whether it's an auth
   issue, a missing agent ID, or a bad argument name.

6. **Small real-money dry run before demo day**
   Use a tiny budget (e.g. 1 USDT) for your first live `create-task` +
   `confirm-accept` — confirm escrow actually funds and you can see the task
   in `onchainos agent tasks` — before trusting it live on camera.

## Project structure

```
quote-runner/
├── server.js                 # Express API (parse -> post -> rank -> approve)
├── lib/
│   ├── taskParser.js         # Groq LLM call: plain text -> structured task JSON
│   ├── marketplaceClient.js  # OKX.AI integration (mock + live-stub)
│   └── scoringEngine.js      # Bid ranking + plain-language explanation (your product IP)
├── public/
│   └── index.html            # UI - single file, no build step
└── .env.example
```

## API endpoints

- `GET /api/status` — sanity check (marketplace mode, whether Groq key is set)
- `POST /api/tasks` — `{ input: "plain language task" }` → parses, posts, ranks bids
- `POST /api/tasks/:taskId/approve` — `{ bidId }` → approves + funds escrow
- `GET /api/tasks/:taskId` — fetch current task state

## What to build next (priority order for your remaining time)

1. **Run the verification checklist above, steps 3-5** — install the CLI,
   register your agent identity, and run one raw `asp-match` call to confirm
   the real JSON field names. This is the single highest-risk remaining unknown.
2. **Reputation lookup** — `asp-match` doesn't appear to return it; find the
   right `agent get-agents` / reputation call and wire it into the scoring
   engine's live-mode path (currently defaults to a neutral 4.0).
3. **Multi-round negotiation** (nice-to-have from the original scope) — have
   Quote Runner counter a bid on the user's behalf.
4. **Preference memory** — reorder future rankings based on past accepted bids,
   for the "concierge that knows you" narrative in your demo script.
5. Record the 90-second demo once live mode is confirmed working, or fall back
   to a clearly-labeled mock-mode demo if OKX API access isn't finalized in time.
