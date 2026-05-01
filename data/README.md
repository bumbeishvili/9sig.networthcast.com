# data/

Daily closing-price series consumed by `index.html` — also published here for anyone who wants to use them directly. Each file is a tab-separated `Date\tClose` table with a single header row. Closes are in USD; the date column uses `M/D/YYYY HH:MM:SS` (16:00:00 New York close).

## Direct download

Pin to `main` for the latest refresh, or pin to a commit SHA for a frozen snapshot.

| File | Raw URL |
| --- | --- |
| `synthetic-qqq.tsv`  | https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/synthetic-qqq.tsv |
| `synthetic-tqqq.tsv` | https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/synthetic-tqqq.tsv |
| `spy.tsv`            | https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/spy.tsv |

## What's in each file

| File | Real history | Synthesized prefix |
| --- | --- | --- |
| `synthetic-qqq.tsv`  | QQQ from 1999-03-10 (yfinance auto-adjusted) | Pre-1999 walked back through `^NDX` (1× − QQQ expense). |
| `synthetic-tqqq.tsv` | TQQQ from 2010-02-11 | 1999 → 2010 via derived NDX-TR (`^NDX × QQQ_adj / QQQ_raw`); pre-1999 via `^NDX` (3× − TQQQ expense). |
| `spy.tsv`            | SPY from 1993-01-29 | 1988 → 1993 via `^SP500TR`; 1985 → 1988 via `^GSPC` (1× − SPY expense). |

The local `^ndx_d.csv` (Stooq) extends `^NDX` history back to the 1930s, so synth QQQ/TQQQ stretch into the pre-1985 era. Treat pre-1985 as "what would have been" rather than "what was" — the actual NASDAQ-100 didn't exist before 1985-01-31, and the back-reconstruction comes from the data provider.

## Known biases

- **Pre-1999 QQQ/TQQQ** uses `^NDX` (price-only). Yahoo's `^XNDX` (NDX Total Return) has no usable history. Synth QQQ understates ~0.7%/yr; synth TQQQ ~2%/yr.
- **1985-10 → 1987-12 SPY** uses `^GSPC` (price-only) because `^SP500TR`'s Yahoo history starts 1988-01-04. Measured TR premium is +3.86pp/yr → ~9% cumulative understatement for that 2.3-year window.

See `update_data.py` at the repo root for the full synthesis logic and formulas.

## Refresh cadence

`.github/workflows/update-data.yml` runs `update_data.py` weekdays at 15:30 UTC and commits any changed files back to `main`. Don't hand-edit — the next refresh will overwrite.
