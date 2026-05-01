#!/usr/bin/env python3
"""
Fetches daily closing prices for QQQ, TQQQ, and SPY from Yahoo Finance and
writes them as TSV files consumed by index.html.

Pre-IPO history is fabricated by walking actual daily index values backward
from each ETF's first real trading day, applying the leveraged-return-minus-
expense formula. There is NO yearly-rate smoothing or dividend top-up — every
synthesized close comes from a real daily index move and the same formula
that approximates the ETF mechanics.

Sources used (all from yfinance, all daily):

  QQQ  pre-1999       ← ^NDX                       (1× − QQQ expense)
  TQQQ pre-1999       ← ^NDX                       (3× − TQQQ expense)
  TQQQ 1999 → 2010    ← derived NDX-TR             (3× − TQQQ expense)
                        = ^NDX × QQQ_adj / QQQ_raw
  SPY  pre-1988       ← ^GSPC, clipped to NDX      (1× − SPY expense)
  SPY  1988 → 1993    ← ^SP500TR                   (1× − SPY expense)

The "derived NDX-TR" trick: real QQQ_adj returns ≈ NDX-TR − QQQ_exp; real
QQQ_raw (split-adjusted only, no dividend reinvestment) returns ≈ NDX − QQQ_exp.
Multiplying ^NDX × (QQQ_adj/QQQ_raw) cancels the QQQ_exp from both sides and
recovers a daily NDX-TR series straight from real market data — not an
annualized estimate. This is what lets the TQQQ 1999-2010 phase track real
TQQQ to within QQQ's small tracking error instead of the −0.6%/yr structural
drift you'd get from chaining through QQQ_adj directly.

Known biases that stem from the data, not the math:

  - For pre-1999 QQQ and TQQQ we have only ^NDX (price-only) — Yahoo lists
    ^XNDX (NDX Total Return) but serves no history for it; NASDAQ.com's API,
    NASDAQ Data Link, Stooq, Tiingo, EODHD, Alpha Vantage all gate it.
    Pre-1999 synth QQQ understates ~0.7%/yr; pre-1999 synth TQQQ ~2%/yr.
  - For 1985-10-01 → 1987-12-31 SPY uses ^GSPC (price-only) because
    ^SP500TR's Yahoo history starts 1988-01-04. Measured TR premium over
    that overlap is +3.86pp/yr, so ~9% cumulative understatement for that
    2.3-year window.

Usage:
    python3 update_data.py
"""
import os
import sys

try:
    import yfinance as yf
except ImportError:
    print("yfinance not installed. Run: pip install yfinance")
    sys.exit(1)

basedir = os.path.dirname(os.path.abspath(__file__))

QQQ_EXPENSE_DAILY  = 0.0020   / 252  # 0.20%   annual
TQQQ_EXPENSE_DAILY = 0.0088   / 252  # 0.88%   annual
SPY_EXPENSE_DAILY  = 0.000945 / 252  # 0.0945% annual

tickers = [
    ('QQQ',  'simulation_tqqq_qqq - qqq.tsv'),
    ('TQQQ', 'simulation_tqqq_qqq - tqqq.tsv'),
    ('SPY',  'simulation_tqqq_qqq - spy.tsv'),
]


def cell(value):
    return float(value.iloc[0]) if hasattr(value, 'iloc') else float(value)


def df_to_pairs(df):
    """yfinance DataFrame -> list of (Timestamp, close), chronological."""
    return [(date, cell(row['Close'])) for date, row in df.iterrows()]


def walk_backward(source_pairs, anchor_date, anchor_price, leverage, expense_daily):
    """Anchor at (anchor_date, anchor_price) and walk source returns backward
    to fabricate target closes for every source date < anchor_date.

    If source contains anchor_date, anchoring is exact (no 1-day lag) and the
    anchor row itself is excluded from the output. Otherwise the anchor is
    placed on the last source date < anchor_date and the entire synth series
    is shifted forward ~1 trading day (the original kludge).

    Returns (rows, pairs):
      rows  = [(date_str_for_tsv, close)]
      pairs = [(Timestamp, close)] — for chaining into a downstream synthesis
    """
    pre = [(d, c) for d, c in source_pairs if d <= anchor_date]
    n = len(pre)
    if n < 2:
        return [], []
    synth = [0.0] * n
    synth[-1] = anchor_price
    for i in range(n - 1, 0, -1):
        ret = (pre[i][1] - pre[i - 1][1]) / pre[i - 1][1]
        synth[i - 1] = max(synth[i] / (1 + leverage * ret - expense_daily), 0)
    exact = pre[-1][0] == anchor_date
    output_n = n - 1 if exact else n
    pairs = [(pre[i][0], synth[i]) for i in range(output_n)]
    rows = [(d.strftime('%-m/%-d/%Y 16:00:00'), c) for d, c in pairs]
    return rows, pairs


def fetch(ticker, auto_adjust=True):
    print(f"Fetching {ticker}{' (raw)' if not auto_adjust else ''}...")
    return yf.download(ticker, period="max", auto_adjust=auto_adjust, progress=False)


qqq_df          = fetch('QQQ')                              # auto-adjusted (TR)
qqq_raw_df      = fetch('QQQ', auto_adjust=False)           # split-adjusted only
tqqq_df         = fetch('TQQQ')
spy_df          = fetch('SPY')
ndx_df          = fetch('^NDX')
gspc_df         = fetch('^GSPC')
sp500tr_df      = fetch('^SP500TR')

ndx_pairs       = df_to_pairs(ndx_df)
qqq_pairs       = df_to_pairs(qqq_df)                       # = QQQ_adj
sp500tr_pairs   = df_to_pairs(sp500tr_df)
ndx_start       = ndx_df.index[0]
gspc_clipped    = [(d, c) for d, c in df_to_pairs(gspc_df) if d >= ndx_start]

# Build derived NDX-TR pairs: ^NDX × QQQ_adj / QQQ_raw, only for dates where
# all three are available (1999-03-10 onwards). Real daily data on both sides.
ndx_map     = dict(ndx_pairs)
qqq_adj_map = {d: cell(row['Adj Close']) for d, row in qqq_raw_df.iterrows()}
qqq_raw_map = {d: cell(row['Close'])     for d, row in qqq_raw_df.iterrows()}
ndx_tr_pairs = []
for d in sorted(qqq_adj_map):
    if d in ndx_map and d in qqq_raw_map and qqq_raw_map[d] > 0:
        ndx_tr_pairs.append((d, ndx_map[d] * qqq_adj_map[d] / qqq_raw_map[d]))


# ---- QQQ pre-1999 (single phase, ^NDX) ----
qqq_prefix_rows, _ = walk_backward(
    ndx_pairs,
    anchor_date=qqq_df.index[0],
    anchor_price=cell(qqq_df['Close'].iloc[0]),
    leverage=1,
    expense_daily=QQQ_EXPENSE_DAILY,
)


# ---- TQQQ: two-phase to avoid double-deducting QQQ expense pre-1999 ----
# Phase 1: 1999 → 2010, walk through derived NDX-TR (real daily ^NDX × QQQ_adj
# / QQQ_raw). The QQQ_exp on both sides cancels, leaving a clean NDX-TR daily
# return — closer to real TQQQ's swap-tracking behavior than chaining through
# real QQQ_adj alone (which would over-deduct 3*QQQ_exp = 0.6%/yr).
phase1_rows, phase1_pairs = walk_backward(
    ndx_tr_pairs,
    anchor_date=tqqq_df.index[0],
    anchor_price=cell(tqqq_df['Close'].iloc[0]),
    leverage=3,
    expense_daily=TQQQ_EXPENSE_DAILY,
)
# Phase 2: pre-1999, walk through ^NDX directly anchored on phase 1's earliest
# synth value. Net daily error ~ -3*dividend_yield = ~-1.5-2%/yr (price-only).
if phase1_pairs:
    p2_anchor_date, p2_anchor_price = phase1_pairs[0]
    phase2_rows, _ = walk_backward(
        ndx_pairs, p2_anchor_date, p2_anchor_price,
        leverage=3, expense_daily=TQQQ_EXPENSE_DAILY,
    )
    tqqq_prefix_rows = phase2_rows + phase1_rows
else:
    tqqq_prefix_rows = phase1_rows


# ---- SPY: two-phase to use real S&P TR data where available ----
# Phase 1: 1988 → 1993, walk through ^SP500TR (real total-return index)
spy_phase1_rows, spy_phase1_pairs = walk_backward(
    sp500tr_pairs,
    anchor_date=spy_df.index[0],
    anchor_price=cell(spy_df['Close'].iloc[0]),
    leverage=1,
    expense_daily=SPY_EXPENSE_DAILY,
)
# Phase 2: 1985 → 1987, walk through ^GSPC (price-only fallback)
if spy_phase1_pairs:
    s2_anchor_date, s2_anchor_price = spy_phase1_pairs[0]
    spy_phase2_rows, _ = walk_backward(
        gspc_clipped, s2_anchor_date, s2_anchor_price,
        leverage=1, expense_daily=SPY_EXPENSE_DAILY,
    )
    spy_prefix_rows = spy_phase2_rows + spy_phase1_rows
else:
    spy_prefix_rows = spy_phase1_rows


prefix_by_ticker = {'QQQ': qqq_prefix_rows, 'TQQQ': tqqq_prefix_rows, 'SPY': spy_prefix_rows}
real_by_ticker   = {'QQQ': qqq_df, 'TQQQ': tqqq_df, 'SPY': spy_df}

for ticker, filename in tickers:
    data = real_by_ticker[ticker]
    prefix_rows = prefix_by_ticker.get(ticker, [])
    decimals = 4 if ticker == 'TQQQ' else 2
    path = os.path.join(basedir, filename)

    with open(path, 'w') as f:
        f.write('Date\tClose\n')
        for date_str, close in prefix_rows:
            f.write(f'{date_str}\t{round(close, decimals)}\n')
        for date, row in data.iterrows():
            date_str = date.strftime('%-m/%-d/%Y 16:00:00')
            f.write(f'{date_str}\t{round(cell(row["Close"]), decimals)}\n')

    if prefix_rows:
        first = prefix_rows[0][0].split(' ')[0]
        last = data.index[-1].strftime('%Y-%m-%d')
        print(f"  {filename}: {len(prefix_rows)} synthesized + {len(data)} real, {first} to {last}")
    else:
        start = data.index[0].strftime('%Y-%m-%d')
        end = data.index[-1].strftime('%Y-%m-%d')
        print(f"  {filename}: {len(data)} rows, {start} to {end}")

print("Done.")
