# Quote Runner

Quote Runner is a meta-agent for the OKX.AI Genesis Hackathon. It turns a plain
English task into a structured marketplace request, finds matching Agent Service
Providers, ranks quotes by price, reputation, and delivery speed, then lets the
user approve one provider and fund escrow through the OKX Agent Payment Protocol.

The goal is simple: make hiring agents feel less like browsing a raw marketplace
and more like asking a trusted procurement desk to compare options for you.

## Demo

Hosted backend: <https://quoterunner-uds7.onrender.com/>

```bash
npm install
cp .env.example .env
# Add GROQ_API_KEY to .env
npm start
```

Open `http://localhost:3000`.

The default `MARKETPLACE_MODE=mock` runs the full product flow without OKX
credentials: task parsing, quote generation, quote ranking, approval, and mock
escrow confirmation. This is the safest mode for a local judge/demo run.

## What It Does

1. The user describes work in natural language.
2. Groq/Llama parses the request into structured task data.
3. Quote Runner asks the marketplace for matching providers.
4. The scoring engine ranks providers with a transparent formula.
5. The user reviews the explanation and approves the best quote.
6. Escrow is funded for the selected provider.

## Why It Matters

Agent marketplaces can become noisy fast: many providers, inconsistent pricing,
unclear reputation signals, and payment flow friction. Quote Runner adds a
decision layer on top of the marketplace so users can compare providers quickly
and understand why a recommendation was made before committing funds.

## OKX.AI Integration

Quote Runner integrates with OKX.AI through the `onchainos` CLI path used by the
Task Marketplace:

- `agent asp-match` for service discovery / quote collection.
- `agent create-task` to publish a task.
- `agent confirm-accept` to accept a provider and fund escrow.
- `okx-a2a` daemon support for receiving ASP job invites.
- A provider watchdog to fail over between AI runtimes if the bound provider
  becomes unavailable.

Live mode is implemented in `lib/marketplaceClient.js`, but it still needs a
small real-marketplace verification pass before being used as the primary demo
path. The mock mode exists so the product can be reviewed even without funded
OKX credentials.

For full live setup and verification steps, see
[`docs/LIVE_OKX_SETUP.md`](docs/LIVE_OKX_SETUP.md).

## Current Implementation

| Component | Status |
| --- | --- |
| Task parser | Real Groq/Llama call from plain text to structured JSON. |
| Quote ranking | Real deterministic scoring logic in `lib/scoringEngine.js`. |
| Mock marketplace | Working end-to-end demo path with simulated providers and escrow. |
| Live marketplace | Implemented through `onchainos`; needs final field-test against live output. |
| Escrow flow | Implemented as `create-task` -> `confirm-accept`; mock mode is demo-safe. |
| ASP delivery support | Includes A2A readiness checks, provider failover, and ASP workspace installer. |

## Project Structure

```text
quote-runner/
|-- server.js                    # Express API and demo server
|-- lib/
|   |-- taskParser.js            # Groq task parsing
|   |-- marketplaceClient.js     # Mock + live OKX.AI marketplace integration
|   |-- scoringEngine.js         # Quote ranking and explanation logic
|   |-- a2aClient.js             # A2A daemon readiness checks
|   |-- providerFallback.js      # AI-provider failover support
|   `-- deliverableBuilder.js    # ASP deliverable formatting
|-- public/
|   |-- index.html               # Landing page
|   `-- app.html                 # Quote Runner desk UI
|-- scripts/
|   |-- install-asp-workspace.js # Writes ASP runtime instructions
|   |-- provider-watchdog.js     # Watches/fails over provider dispatch
|   `-- rank-for-job.js          # Builds ASP ranking deliverable for a job
|-- docs/
|   `-- LIVE_OKX_SETUP.md        # Live OKX.AI setup and verification notes
`-- .env.example
```

## API

- `GET /api/status` - app, credential, wallet, and A2A readiness status.
- `GET /api/funding?amount=1` - XLayer USDT funding preflight in live mode.
- `POST /api/tasks` - parse a plain-language request, collect quotes, rank them.
- `POST /api/tasks/:taskId/approve` - approve a quote and fund escrow.
- `GET /api/tasks/:taskId` - fetch the current in-memory task state.

## Known Limitations

- Live marketplace mode depends on the local `onchainos` and `okx-a2a` setup.
- `asp-match` behaves like service discovery over listed ASP services, not an
  open real-time auction. Quote Runner's ranking is real, but the source quotes
  are matched provider listings.
- The exact live `asp-match` JSON response shape should be verified once with a
  funded/registered OKX.AI environment before recording a live demo.
- Reputation data may need a separate lookup if `asp-match` does not return it;
  the live path currently falls back to neutral values when needed.

## Next Steps

- Field-test one live `asp-match` response and tighten any field mappings.
- Add explicit automated tests for the scoring engine.
- Add provider preference memory based on previously accepted quotes.
- Add negotiation/counter-offer support for multi-round provider selection.
