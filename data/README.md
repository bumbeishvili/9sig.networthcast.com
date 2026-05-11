# Long-history TQQQ, QQQ, and SPY price data (+ short-rate reference data)

This folder contains daily closing-price series for **TQQQ, QQQ, and SPY** stretching back **decades before any of these ETFs actually existed**, along with the **historical short-term interest rate series** the synthesis methodology depends on. They power the [Strategies Simulator](https://9sig.networthcast.com), and they're published here so anyone can grab them and run their own backtests without reinventing the synthesis work.

## Why these files exist

If you want to ask "what would 9Sig (or simple buy-and-hold) have done over a 40-year window?", you have a problem: the funds themselves are too young.

- **SPY** started trading in **January 1993**.
- **QQQ** started in **March 1999**.
- **TQQQ** (3× leveraged Nasdaq-100) only launched in **February 2010**.

That gives TQQQ less than two decades of real history — not enough to see how a leveraged strategy would have behaved through, say, the dot-com crash or the 1973–74 bear market. So we **reconstruct** the missing years from older indexes that *do* have long histories (the Nasdaq-100 itself, the S&P 500), apply the same daily formulas the ETFs use (leverage, expense ratios, **financing costs on the borrowed leg**), and stitch the synthetic series onto the real one at the day each ETF actually launched.

The result is a continuous "what it would have looked like" series for each fund going back as far as 1938 in some cases. It's not what really happened — those investments didn't exist yet — but it's what *the math says* their daily prices would have done given the underlying index **and the prevailing short-term interest rates of each era**.

## The files

| File | Real history starts | Synthesized portion |
| --- | --- | --- |
| **synthetic-qqq.tsv** | March 10, 1999 — when QQQ launched. From here on it's real, dividend-adjusted Yahoo Finance data. | Before 1999 the series is built from the Nasdaq-100 index (`^NDX`), minus QQQ's tiny expense ratio. No financing-cost adjustment (QQQ is not leveraged). |
| **synthetic-tqqq.tsv** | February 11, 2010 — when TQQQ launched. | Pre-2010 uses a leveraged-ETF formula that **includes the financing cost**: `(1 + 3 × NDX_daily − 2 × short_rate_daily − TQQQ_expense_daily)`. For 1999–2010 the underlying is the derived NDX-TR series (real Nasdaq movement plus actual dividends); for 1938–1999 it falls back to price-only `^NDX` because dividend data isn't available that far back. |
| **spy.tsv** | January 29, 1993 — when SPY launched. | 1988–1993 uses the real S&P 500 Total Return index. 1985–1988 falls back to the plain S&P 500 (`^GSPC`) because total-return data isn't available that far back. No financing-cost adjustment (SPY is not leveraged). |
| **fed-funds-effective.tsv** | Daily, July 1, 1954 → present. | None — pulled from FRED series `DFF`. Used by the TQQQ synthesis to compute the financing cost on the leveraged leg from 1954 onward. |
| **t-bill-3mo.tsv** | Monthly, January 1934 → present. | None — pulled from FRED series `TB3MS`. Used as the pre-Fed-Funds-market (1934–1953) short-rate proxy. |
| **short-rates.tsv** | Daily, January 2, 1934 → present. | Derived: DFF where it exists, TB3MS forward-filled where DFF doesn't reach. This is the single file the synthesis script reads. |

A local `^ndx_d.csv` (sourced from Stooq) extends Nasdaq-100 history back to **January 1938**. The actual Nasdaq-100 index didn't exist before 1985, so values before then are themselves a back-reconstruction by the data provider — treat pre-1985 synthetic QQQ/TQQQ as "rough hypothetical" rather than gospel.

## The financing-cost correction (why this matters)

A leveraged ETF holding $1 of investor NAV produces $3 of NDX exposure by **borrowing** the extra $2 of synthetic exposure from a bank via total-return swap. The bank charges interest on that $2 every day. Meanwhile the fund's $1 of cash collateral earns roughly the same short-term rate. Net daily drag:

```
financing_drag_daily ≈ (L − 1) × short_rate_daily
                     = 2 × short_rate_daily   (for L=3, i.e. TQQQ)
```

**This drag is invisible in ProShares' published expense ratio** (0.88 %/year — the management fee) but is the dominant cost component in any non-zero interest-rate environment. Empirically verified against 2010-present TQQQ data:

- Regression of (naive synthesis − real TQQQ) on Fed Funds rate over 17 years → **slope 1.998** (theory predicts exactly 2.0), **R² 0.97**.
- In 2023 with Fed Funds at 5 %: real TQQQ underperformed a "no-financing-cost" synthesis by **11.3 percentage points** — matching `2 × 5 % = 10 %` predicted drag almost perfectly.
- In 2010–2015 with Fed Funds near 0 %: drag was only ~1.3 %/year (the irreducible operational residual).

Pre-2010 backtests done without this correction are **wildly optimistic** in any high-rate era. The 1970s and early 80s (Fed Funds 7–19 %) would have eaten **15–35 percentage points/year** of TQQQ's returns to financing alone.

## How accurate is the synthesized portion?

After applying the financing-cost correction, the remaining known biases are:

1. **Missing dividends pre-1999.** For pre-1999 QQQ and TQQQ we have only `^NDX` (price-only) — Yahoo lists `^XNDX` (NDX Total Return) but serves no history for it; NASDAQ.com's API, NASDAQ Data Link, Stooq, Tiingo, EODHD, and Alpha Vantage all gate it. Pre-1999 synth QQQ understates by ~0.7 %/year; pre-1999 synth TQQQ understates by ~2 %/year (= 3 × dividend yield).

2. **Operational drag not modeled.** Real TQQQ also pays swap-counterparty spreads (~50 bps on the swap notional), absorbs NAV-vs-market price deviations, and accumulates daily-rebalancing slippage. Total: ~1.3 %/year. Our corrected synthesis ignores this — so synthetic TQQQ remains roughly that constant amount too HIGH versus what real-world TQQQ would have delivered.

3. **1985–1987 SPY uses price-only S&P 500** because `^SP500TR`'s Yahoo history starts 1988-01-04. Measured TR premium over the overlap is +3.86 pp/year, so ~9 % cumulative understatement for that 2.3-year window.

Net direction of bias on TQQQ pre-2010 (vs what real TQQQ would have done if it existed):
- **Low-rate eras** (1938–45, mid-1950s): synthetic ≈ flat to slightly low (dividend gap > tiny operational drag).
- **Moderate-rate eras** (most history): synthetic ≈ slightly high by 1–3 pp/year.
- **High-rate eras** (1970s–80s): synthetic ≈ high by 2–3 pp/year operational, but rate effect is now corrected, so net is much smaller than the previous uncorrected synthesis.

For everything **from 2010 (TQQQ), 1999 (QQQ), and 1988 (SPY) onward** the price data is real and dividend-adjusted, so backtests over the last 15–25 years are unaffected by any synthesis biases.

## How to use the data

### Direct download

You can grab any of the files straight from GitHub at the URLs below. They're refreshed automatically every weekday with the latest closing prices and the latest Fed Funds rate, and there's no rate-limiting on these endpoints — it's safe to point an app or script directly at them and have your data stay current.

| File | URL |
| --- | --- |
| QQQ  | [https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/synthetic-qqq.tsv](https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/synthetic-qqq.tsv) |
| TQQQ | [https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/synthetic-tqqq.tsv](https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/synthetic-tqqq.tsv) |
| SPY  | [https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/spy.tsv](https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/spy.tsv) |
| Fed Funds Effective Rate (daily, 1954+) | [https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/fed-funds-effective.tsv](https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/fed-funds-effective.tsv) |
| 3-month T-bill (monthly, 1934+) | [https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/t-bill-3mo.tsv](https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/t-bill-3mo.tsv) |
| Combined daily short rates (1934+) | [https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/short-rates.tsv](https://raw.githubusercontent.com/bumbeishvili/9sig.networthcast.com/refs/heads/main/data/short-rates.tsv) |

### File format

Every file is a plain tab-separated table:

```
Date	Close              ← price files (Close column)
1/2/2025 16:00:00	38.93
1/3/2025 16:00:00	40.79
...

Date	Rate               ← rate files (Rate column, value in % per year)
7/1/1954 16:00:00	1.1300
7/2/1954 16:00:00	1.2500
...
```

- One row per trading day (or per month for `t-bill-3mo.tsv`).
- The date column always says `16:00:00` — that's the New York 4 PM close.
- Price closes are in **US dollars**. Rate values are **annual percentages**.
- Dates use `M/D/YYYY` formatting.

Every spreadsheet, Python script, R notebook, etc. can read this with default settings (just tell it the delimiter is a tab).

## Daily auto-refresh

A scheduled GitHub Action runs every weekday at 15:30 UTC (about two hours after the US market opens), regenerates all six files from the latest Yahoo Finance and FRED data, and pushes them back to the repository. Whatever you fetch from the URLs above is always the latest version — no caching layer to wait on.

If you find a bug in the synthesis logic or have a suggestion, open an issue or send a PR against the script that generates the files (`update_data.py` at the repo root).

## A note on synthetic backtesting

These synthetic series are reconstructions, not history. They're as good as we can do given that QQQ and TQQQ simply weren't around through most market cycles people care about — but they should be read in that spirit. If a strategy backtest looks great in 1973 or 2000, that's a *what-if*, not a track record. Treat them accordingly.

The financing-cost correction (added 2026-05) closes the single biggest source of error in the previous synthesis, but a ~1.3 %/year operational residual remains unmodeled. **Absolute CAGRs from pre-2010 backtests are still approximate by ~1–2 percentage points**; relative comparisons between strategies (which all touch the same underlying) remain reliable.
