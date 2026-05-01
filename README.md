# 9sig.networthcast.com

Interactive simulator for the 9Sig strategy on synthetic TQQQ (3x QQQ), with comparisons to buy-and-hold TQQQ, QQQ, and SPY.

Live: https://9sig.networthcast.com

## Updating price data

Daily closing prices for QQQ, TQQQ, and SPY live in three TSV files under `data/`. To refresh them to the latest available date:

```bash
# One-time setup (creates a venv and installs yfinance)
python3 -m venv .venv
.venv/bin/pip install yfinance

# Refresh QQQ / TQQQ / SPY TSVs
.venv/bin/python3 update_data.py
```

The script pulls `period="max"` with `auto_adjust=True` so every series is dividend- and split-adjusted on the same basis — comparisons between them remain fair. Output files:

- `data/simulation_tqqq_qqq - qqq.tsv` (QQQ, 1999–present)
- `data/simulation_tqqq_qqq - tqqq.tsv` (real TQQQ, 2010–present; pre-2010 is synthesized in the browser from QQQ returns)
- `data/simulation_tqqq_qqq - spy.tsv` (SPY, 1993–present)

## Automated daily refresh

`.github/workflows/update-data.yml` runs `update_data.py` on a schedule and commits any changed TSVs back to `main`.

- **Schedule**: 15:30 UTC, Monday–Friday (`30 15 * * 1-5`) — 11:30 AM ET during DST, 10:30 AM ET in winter; always safely after the 9:30 AM ET market open.
- **Manual trigger**: `workflow_dispatch` — run it on demand from the Actions tab.
- **No-op on holidays**: the commit step checks `git diff --quiet -- 'data/*.tsv'` and exits cleanly if nothing changed (market closed, no new bar).
- **Permissions**: the workflow uses the default `GITHUB_TOKEN` with `contents: write` to push the refresh commit. If org-level settings block workflow pushes, flip *Settings → Actions → General → Workflow permissions* to "Read and write".

Cron in GitHub Actions is UTC and not DST-aware, so the local-time window drifts by one hour twice a year. Both windows are comfortably past market open, so the 2-hour post-open buffer is preserved year-round.
