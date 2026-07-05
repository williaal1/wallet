# Wallet

Personal spending wallet, V2. A static page (GitHub Pages) backed by a Cloudflare Worker that commits every entry to `spending_log.csv` in this repo. The phone stores nothing that can't be trivially recovered — the V1 lockout (GitHub PAT in localStorage, accidentally reset) is architecturally impossible here.

The budget model this app serves lives on the laptop: `claude-projects/Personal/Controls/Personal Budgeting/V2/budget-model.md`.

## How the wallet works

- **+$55 lands at midnight** (America/New_York) every day, including the day of the last reset
- Balance = accrued days × rate − everything logged since the last reset
- **Reset button**: lost track for a few days? Reset. Balance restarts from today. Resets are just rows in the CSV — honest data, not erasure
- Negative balance shows its **recovery date** ("back positive Wed Jul 9")
- No cap, no months, no epochs

## Architecture

```
Phone (GitHub Pages, static)
  → Cloudflare Worker "wallet-api" (holds GITHUB_TOKEN + WALLET_KEY)
    → commits to spending_log.csv here
      → laptop pulls for analysis
```

- `config.json` — daily rate, categories, Worker URL. Read by both the page and the Worker. Re-rating the wallet is a one-line change here.
- `spending_log.csv` — the ledger. `timestamp,amount,category,note`; RESET rows mark wallet resets.
- `worker/` — the Cloudflare Worker source. Deploy with `npx wrangler deploy` from `worker/`.

## Worker API

All endpoints require the shared key (`X-Wallet-Key` header or `?k=` param):

- `GET /state` → `{balance, rate, today_spent, today_entries, recovery_date, last_reset}`
- `POST /log` `{amount, category, note?}` → new state
- `POST /reset` → new state

## Setup / recovery runbook

1. **Worker secrets** (from `worker/`):
   - `npx wrangler secret put GITHUB_TOKEN` — fine-grained PAT: repo `williaal1/wallet` only, permission Contents read/write, expiration none
   - `npx wrangler secret put WALLET_KEY` — any long random string; also goes in the phone bookmark URL
2. **Deploy**: `cd worker && npx wrangler deploy`, put the printed URL in `config.json` (`worker_url`), commit
3. **Phone**: open `https://williaal1.github.io/wallet/?k=<WALLET_KEY>`, Add to Home Screen
4. **Phone wiped / key lost?** The key is in this runbook's Worker (`npx wrangler secret` to rotate) — just re-add the bookmark. Nothing to regenerate, no lockout
5. **Token rotated/revoked?** Make a new PAT (step 1), `npx wrangler secret put GITHUB_TOKEN` again. The phone never notices

## Categories

Groceries · Restaurants · Shopping · Books/Records · Car · Travel · Other

Car = operation (gas, tolls, parking, maintenance). Car ownership (loan, insurance) is a fixed cost in the budget model, not wallet spending.
