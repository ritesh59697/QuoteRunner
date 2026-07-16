# Live OKX.AI Setup

This document keeps the detailed live-mode notes out of the hackathon-facing
README while preserving the operational checklist needed for a real OKX.AI run.

## Architecture Note

`asp-match` is a discovery/quote query against already-listed ASP services. It
returns matching services and their fee; it is not an open auction where agents
bid independently in real time. Quote Runner's ranking/scoring layer is still the
product differentiation, but the live mechanism is closer to smart quote
comparison across matched providers.

## Switch To Live Mode

1. Get `OKX_API_KEY`, `OKX_SECRET_KEY`, and `OKX_PASSPHRASE` from the OKX
   Developer Portal.
2. In this project directory, run:
   ```bash
   npx skills add okx/onchainos-skills
   ```
3. Install the `onchainos` CLI binary. The skills step installs skill markdown
   for agent context; the CLI binary itself is separate.
4. Register a User-role agent identity:
   ```bash
   onchainos agent create --role user
   ```
   Put the resulting ID in `.env` as `OKX_AGENT_ID`.
5. Configure the ASP identity:
   - `OKX_ASP_AGENT_ID`
   - `OKX_ASP_SERVICE_ID`
   - `OKX_ASP_SERVICE_FEE_USDT`

   The fee must match the live listing. Check it with:
   ```bash
   onchainos agent service-list --agent-id <ASP id>
   ```
6. Install and start the A2A daemon:
   ```bash
   npm install -g @okxweb3/a2a-node@latest
   okx-a2a doctor --fix
   ```

   Run `doctor --fix` from the AI CLI you want bound, and only for first-time
   setup. Re-running it later from a different tool can rebind the provider to
   that tool.
7. Start the provider watchdog in a separate terminal:
   ```bash
   npm run watchdog
   ```
8. Wire real deliverables into the ASP AI workspace:
   ```bash
   npm run install-asp
   ```

   This writes instructions into `~/.okx-agent-task/workspace` so accepted jobs
   run this project's ranking deliverable instead of letting the daemon AI
   improvise.
9. Set live mode in `.env`:
   ```bash
   MARKETPLACE_MODE=live
   ```
10. Restart the app:
    ```bash
    npm start
    ```

## Verification Checklist

Run these in order so failures are isolated to one layer.

### 1. Mock Smoke Test

```bash
npm install
cp .env.example .env
# add GROQ_API_KEY
npm start
```

Open `http://localhost:3000`, then use the desk at `/app.html`. Submit a task
and confirm you see ranked quotes plus an approval flow.

### 2. Groq Check

```bash
curl https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"llama-3.1-8b-instant","messages":[{"role":"user","content":"say hi"}]}'
```

If this fails, fix the Groq account/key before debugging the app.

### 3. CLI Sanity Check

```bash
npx skills add okx/onchainos-skills
onchainos --version
onchainos agent create --role user
```

If `onchainos agent create` fails or hangs, fix the CLI install before turning
on live mode.

### 4. Raw `asp-match` Test

```bash
onchainos agent asp-match \
  --task-desc "design a logo for a coffee brand" \
  --agent-id <your OKX_AGENT_ID> \
  --format json
```

Compare the returned JSON keys against the fallbacks in
`postTaskAndCollectBids()` in `lib/marketplaceClient.js`. The most likely live
adjustment is a field-name mismatch around provider ID, fee, reputation, or ETA.

### 5. Live App Test

Set `MARKETPLACE_MODE=live`, restart with `npm start`, and repeat the app flow.
Watch the terminal output from `runOnchainos()`; it prints the command and stderr
needed to distinguish auth, missing agent IDs, funding, or argument-name errors.

### 6. Small Real-Money Dry Run

Use a tiny budget first. Confirm `create-task` and `confirm-accept` fund escrow
and that the task appears in:

```bash
onchainos agent tasks
```

## Demo-Day Notes

- `asp-match` only returns ASPs with already-listed matching services. If the
  marketplace is thin for one category, prepare a backup task phrasing.
- Heartbeat status and job-receive readiness are separate. An agent can report
  online while missing inbound invites if the A2A daemon is not actually ready.
- Check readiness with:
  ```bash
  npm run provider:check
  ```
- For a guaranteed smooth judge review, use mock mode unless live OKX.AI has
  already passed the checklist above.
