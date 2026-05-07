# Long-history TQQQ, QQQ, and SPY price data

This folder contains daily closing-price series for **TQQQ, QQQ, and SPY** stretching back **decades before any of these ETFs actually existed**. They power the [TQQQ Strategies Simulator](https://9sig.networthcast.com), and they're published here so anyone can grab them and run their own backtests without reinventing the synthesis work.

## Why these files exist

If you want to ask "what would 9Sig (or simple buy-and-hold) have done over a 40-year window?", you have a problem: the funds themselves are too young.

- **SPY** started trading in **January 1993**.
- **QQQ** started in **March 1999**.
- **TQQQ** (3× leveraged Nasdaq-100) only launched in **February 2010**.

That gives TQQQ less than two decades of real history — not enough to see how a leveraged strategy would have behaved through, say, the dot-com crash or the 1973–74 bear market. So we **reconstruct** the missing years from older indexes that *do* have long histories (the Nasdaq-100 itself, the S&P 500), apply the same daily formulas the ETFs use (leverage, expense ratios), and stitch the synthetic series onto the real one at the day each ETF actually launched.

The result is a continuous "what it would have looked like" series for each fund going back as far as 1938 in some cases. It's not what really happened — those investments didn't exist yet — but it's what *the math says* their daily prices would have done given the underlying index.

## The three files

| File | Real history starts | Synthesized portion |
| --- | --- | --- |
| **synthetic-qqq.tsv** | March 10, 1999 — when QQQ launched. From here on it's real, dividend-adjusted Yahoo Finance data. | Before 1999 the series is built from the Nasdaq-100 index (`^NDX`), minus QQQ's tiny expense ratio. |
| **synthetic-tqqq.tsv** | February 11, 2010 — when TQQQ launched. | 1999–2010 uses a derived "Nasdaq-100 total return" series (real Nasdaq movement plus actual dividends), times 3× minus TQQQ's expense ratio. Pre-1999 falls back to the price-only Nasdaq-100 (no dividends available that far back). |
| **spy.tsv** | January 29, 1993 — when SPY launched. | 1988–1993 uses the real S&P 500 Total Return index. 1985–1988 falls back to the plain S&P 500 (`^GSPC`) because total-return data isn't available that far back. |

A local file (`^ndx_d.csv`, sourced from Stooq) extends Nasdaq-100 history all the way back to **January 1938**. That's how the synthetic QQQ and TQQQ series can stretch into the pre-WWII era. Note that the *actual* Nasdaq-100 index didn't exist before 1985 — those very early values are themselves a back-reconstruction by the data provider, so anything before 1985 should be treated as "rough hypothetical" rather than gospel.

## How accurate is the synthesized portion?

Pretty close, but not perfect. Two known limitations to be aware of:

- **Pre-1999 QQQ and TQQQ values understate the real return**, because we don't have daily dividend data for the Nasdaq-100 going that far back. Synthetic QQQ is roughly **0.7% per year** too low; synthetic TQQQ roughly **2% per year** too low. Long-window backtests should bear this in mind — actual returns would have been somewhat higher.
- **1985 to 1987 SPY** uses price-only S&P 500 data because the total-return version's history doesn't reach back that far. About **9% of cumulative return** is missing across that 2.3-year stretch.

For everything from 1999 (QQQ), 2010 (TQQQ), and 1988 (SPY) onward the data is real and dividend-adjusted, so backtests over the last 15–25 years are unaffected by these biases.

## How to use the data

### Direct download

You can grab any of the files straight from GitHub at the URLs below. They're refreshed automatically every weekday with the latest closing prices, and there's no rate-limiting on these endpoints — it's safe to point an app or script directly at them and have your data stay current.

| File | URL |
| --- | --- |
| QQQ  | [https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/synthetic-qqq.tsv](https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/synthetic-qqq.tsv) |
| TQQQ | [https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/synthetic-tqqq.tsv](https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/synthetic-tqqq.tsv) |
| SPY  | [https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/spy.tsv](https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/spy.tsv) |

### File format

Each file is a plain tab-separated table:

```
Date	Close
1/2/2025 16:00:00	38.93
1/3/2025 16:00:00	40.79
...
```

- One row per trading day.
- The date column always says `16:00:00` — that's the New York 4 PM close.
- Closes are in **US dollars**.
- Dates use `M/D/YYYY` formatting.

Every spreadsheet, Python script, R notebook, etc. can read this with default settings (just tell it the delimiter is a tab).

## Daily auto-refresh

A scheduled GitHub Action runs every weekday at 15:30 UTC (about two hours after the US market opens), regenerates all three files from the latest Yahoo Finance data, and pushes them back to the repository. Whatever you fetch from the URLs above is always the latest version — no caching layer to wait on.

If you find a bug in the synthesis logic or have a suggestion, open an issue or send a PR against the script that generates the files (`update_data.py` at the repo root).

## A note on synthetic backtesting

These synthetic series are reconstructions, not history. They're as good as we can do given that QQQ and TQQQ simply weren't around through most market cycles people care about — but they should be read in that spirit. If a strategy backtest looks great in 1973 or 2000, that's a *what-if*, not a track record. Treat them accordingly.
