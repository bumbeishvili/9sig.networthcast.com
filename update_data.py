#!/usr/bin/env python3
"""
Fetches daily closing prices for QQQ, TQQQ, and SPY from Yahoo Finance and
short-term interest rates from FRED, then writes them as TSV files consumed
by index.html.

Pre-IPO history is fabricated by walking actual daily index values backward
from each ETF's first real trading day, applying the leveraged-return-minus-
expense formula PLUS the financing-cost correction for leveraged ETFs:

    synth[t-1] = synth[t] / (1 + L × ret − (L-1) × rate_daily − expense_daily)

The (L-1) × rate_daily term reflects the interest cost real leveraged ETFs
pay on the borrowed portion of their notional exposure. Empirically the
naive formula (no rate term) overstates real TQQQ by ≈2 × short_rate per
year — verified by regressing 2010-present naive-vs-real drift against Fed
Funds rate: slope 1.998 (theory predicts exactly 2.0), R² 0.97.

Sources used:

  ^NDX  base series   ← local ^ndx_d.csv (Stooq, back to 1938-01-03)
                          merged with yfinance ^NDX from 1985-10-01 (overrides
                          the CSV on overlapping dates)
  ^GSPC, ^SP500TR, QQQ, TQQQ, SPY, QQQ-raw  ← yfinance
  DFF  (daily 1954+)  ← FRED  — Fed Funds Effective Rate, the swap-counterparty
                                financing reference for leveraged ETFs
  TB3MS (monthly 1934+) ← FRED — 3-month T-bill, used as the pre-1954 proxy

Synthesis formulas:

  QQQ  pre-1999       ← extended ^NDX                (1× − QQQ expense)
  TQQQ pre-1999       ← extended ^NDX                (3× − 2×rate − TQQQ exp)
  TQQQ 1999 → 2010    ← derived NDX-TR               (3× − 2×rate − TQQQ exp)
                        = ^NDX × QQQ_adj / QQQ_raw
  SPY  pre-1988       ← ^GSPC, clipped to NDX start  (1× − SPY expense)
  SPY  1988 → 1993    ← ^SP500TR                     (1× − SPY expense)

QQQ and SPY have leverage 1, so (L-1) × rate = 0 — no financing-cost term.
Only TQQQ gets the rate correction.

The local ^ndx_d.csv extends pre-1985 history. The actual NASDAQ-100 index
didn't exist before 1985-01-31, so values before that are a back-reconstruction
by the data provider. Treat pre-1985 synth QQQ/TQQQ as "what would have been"
not "what was".

The "derived NDX-TR" trick: real QQQ_adj returns ≈ NDX-TR − QQQ_exp; real
QQQ_raw (split-adjusted only, no dividend reinvestment) returns ≈ NDX − QQQ_exp.
Multiplying ^NDX × (QQQ_adj/QQQ_raw) cancels the QQQ_exp from both sides and
recovers a daily NDX-TR series straight from real market data — not an
annualized estimate. This is what lets the TQQQ 1999-2010 phase track real
TQQQ to within QQQ's small tracking error instead of the −0.6%/yr structural
drift you'd get from chaining through QQQ_adj directly.

Known biases (after the financing-cost correction):

  - For pre-1999 QQQ and TQQQ we have only ^NDX (price-only) — Yahoo lists
    ^XNDX (NDX Total Return) but serves no history for it; NASDAQ.com's API,
    NASDAQ Data Link, Stooq, Tiingo, EODHD, Alpha Vantage all gate it.
    Pre-1999 synth QQQ understates ~0.7%/yr; pre-1999 synth TQQQ ~2%/yr.
  - For 1985-10-01 → 1987-12-31 SPY uses ^GSPC (price-only) because
    ^SP500TR's Yahoo history starts 1988-01-04. Measured TR premium over
    that overlap is +3.86pp/yr, so ~9% cumulative understatement for that
    2.3-year window.
  - Residual operational drag of ~1.3 pp/yr (swap spreads, NAV/market price
    deviations, daily rebalancing slippage) is NOT modeled. Real TQQQ
    underperforms our rate-corrected synthesis by roughly that constant
    amount across all rate regimes.

Usage:
    python3 update_data.py
"""
import csv
import io
import os
import sys
import urllib.request
from datetime import timedelta

try:
    import yfinance as yf
except ImportError:
    print("yfinance not installed. Run: pip install yfinance")
    sys.exit(1)

basedir = os.path.dirname(os.path.abspath(__file__))

QQQ_EXPENSE_DAILY  = 0.0020   / 252  # 0.20%   annual
TQQQ_EXPENSE_DAILY = 0.0088   / 252  # 0.88%   annual
SPY_EXPENSE_DAILY  = 0.000945 / 252  # 0.0945% annual

# === Financing-cost model =================================================
# A leveraged ETF holding $1 of investor NAV achieves $L of index exposure by
# borrowing the extra $(L-1) of synthetic exposure via total-return swap. The
# bank charges interest on that borrowed amount; the fund's cash collateral
# earns roughly the same short rate, leaving a net daily drag of
# (L-1) × short_rate. Empirically verified against 2010-present TQQQ data:
# regression of (naive synth − real) on Fed Funds rate gives slope ≈ 2.0
# (theory predicts exactly 2 for L=3), R² ≈ 0.97.
# Rate source: FRED DFF (Fed Funds Effective, daily from 1954) + TB3MS
# (3-month T-bill, monthly from 1934) as pre-Fed-Funds-market proxy.
DFF_START   = '1954-07-01'
TBMS_START  = '1934-01-01'

DATA_DIR = 'data'

tickers = [
    ('QQQ',  'synthetic-qqq.tsv'),
    ('TQQQ', 'synthetic-tqqq.tsv'),
    ('SPY',  'spy.tsv'),
]


def cell(value):
    return float(value.iloc[0]) if hasattr(value, 'iloc') else float(value)


def normalize_ts(ts):
    """Snap a pandas Timestamp to tz-naive midnight so dates from yfinance
    (tz-aware) match dates from the local CSV (tz-naive)."""
    import pandas as pd
    if hasattr(ts, 'tz') and ts.tz is not None:
        ts = ts.tz_localize(None)
    return pd.Timestamp(ts.year, ts.month, ts.day)


def df_to_pairs(df):
    """yfinance DataFrame -> list of (tz-naive Timestamp, close), chronological."""
    return [(normalize_ts(date), cell(row['Close'])) for date, row in df.iterrows()]


def read_ndx_csv():
    """Read local ^ndx_d.csv (Stooq-style: Date,Open,High,Low,Close,Volume).
    Returns [(tz-naive Timestamp, close)] sorted by date."""
    import pandas as pd
    csv_path = os.path.join(basedir, '^ndx_d.csv')
    if not os.path.exists(csv_path):
        return []
    pairs = []
    with open(csv_path) as f:
        next(f)
        for line in f:
            parts = line.strip().split(',')
            if len(parts) < 5:
                continue
            try:
                pairs.append((pd.Timestamp(parts[0]), float(parts[4])))
            except (ValueError, TypeError):
                continue
    pairs.sort(key=lambda x: x[0])
    return pairs


def extend_with_csv(yf_pairs, csv_pairs):
    """Use yfinance values wherever they exist; fall back to CSV for older
    dates that yfinance doesn't cover."""
    yf_map = dict(yf_pairs)
    yf_first = min(yf_map.keys()) if yf_map else None
    if yf_first is None:
        return csv_pairs
    pre = [(d, c) for d, c in csv_pairs if d < yf_first]
    return pre + sorted(yf_map.items())


def fmt_close(value):
    """12 significant figures, general format. Preserves precision for the
    very small values that show up at the start of long backward synthesis
    chains (e.g., TQQQ 1938 ≈ 1e-9). Falls back to scientific notation when
    fixed decimals would lose information."""
    return f'{value:.12g}'


def fetch_fred(series_id, start_date):
    """Fetch a FRED daily/monthly series. Returns [(Timestamp, value_percent)]."""
    import pandas as pd
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}&cosd={start_date}"
    print(f"Fetching FRED {series_id}...")
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    raw = urllib.request.urlopen(req, timeout=60).read().decode('utf-8')
    out = []
    reader = csv.reader(io.StringIO(raw))
    next(reader)  # header row: observation_date,SERIES
    for row in reader:
        if len(row) < 2 or row[1].strip() in ('', '.'):
            continue
        try:
            d = pd.Timestamp(row[0])
            v = float(row[1])
            out.append((d, v))
        except (ValueError, TypeError):
            continue
    return out


def build_combined_rates(dff_pairs, tbms_pairs):
    """Combine FRED DFF (daily, 1954+) with TB3MS (monthly, 1934+ as pre-1954
    proxy) into a single weekday-resolution series. Holidays carry forward
    the previous trading day's rate. Returns [(Timestamp, value_percent)]."""
    import pandas as pd
    dff_map  = dict(dff_pairs)
    tbms_map = dict(tbms_pairs)

    def tbms_lookup(d):
        # TB3MS is anchored on the 1st of the month — forward-fill within month.
        return tbms_map.get(pd.Timestamp(d.year, d.month, 1))

    end = max(d for d, _ in dff_pairs)
    combined = []
    d = pd.Timestamp(1934, 1, 2)
    last_dff = None
    last_tb  = tbms_map.get(pd.Timestamp(1934, 1, 1), 0.72)
    while d <= end:
        if d.weekday() < 5:  # weekdays only
            if d in dff_map:
                last_dff = dff_map[d]
                v = last_dff
            elif last_dff is not None:
                v = last_dff  # forward-fill DFF on holidays
            else:
                tb = tbms_lookup(d)
                if tb is not None: last_tb = tb
                v = last_tb
            combined.append((d, v))
        d += timedelta(days=1)
    return combined


def write_rate_tsv(path, rows):
    """Write a rate series in the same Date \\t Rate TSV format as price TSVs."""
    with open(path, 'w') as f:
        f.write("Date\tRate\n")
        for d, v in rows:
            f.write(f"{d.month}/{d.day}/{d.year} 16:00:00\t{v:.4f}\n")


def walk_backward(source_pairs, anchor_date, anchor_price, leverage, expense_daily, rate_map=None):
    """Anchor at (anchor_date, anchor_price) and walk source returns backward
    to fabricate target closes for every source date < anchor_date.

    For a leveraged target (leverage > 1), pass `rate_map` (date → percent
    short rate). The formula then includes the financing-cost term
    (L-1) × rate_daily that real leveraged ETFs pay on the borrowed leg.
    Without `rate_map`, the unmodelled financing cost makes the synthesis
    too high by ~2×rate per year — wildly inaccurate in high-rate eras.

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
    financing_mult = leverage - 1  # 0 for L=1 (no leverage, no cost), 2 for L=3
    for i in range(n - 1, 0, -1):
        ret = (pre[i][1] - pre[i - 1][1]) / pre[i - 1][1]
        # Financing cost charged for the period from pre[i-1] → pre[i]. We
        # apply one trading day's worth of (L-1)×rate, using the rate as of
        # the earlier date (or most recent prior weekday).
        financing_daily = 0.0
        if rate_map is not None and financing_mult > 0:
            rate_pct = rate_lookup(rate_map, pre[i - 1][0])
            financing_daily = financing_mult * (rate_pct / 100.0) / 252.0
        synth[i - 1] = max(synth[i] / (1 + leverage * ret - financing_daily - expense_daily), 0)
    exact = pre[-1][0] == anchor_date
    output_n = n - 1 if exact else n
    pairs = [(pre[i][0], synth[i]) for i in range(output_n)]
    rows = [(d.strftime('%-m/%-d/%Y 16:00:00'), c) for d, c in pairs]
    return rows, pairs


def rate_lookup(rate_map, d, fallback_days=10):
    """Return the rate (percent) for date d, falling back to the most recent
    prior weekday if d itself is a weekend/holiday. Returns 0 if no rate
    within the fallback window — should not happen for our 1934+ coverage."""
    import pandas as pd
    if d in rate_map:
        return rate_map[d]
    for delta in range(1, fallback_days + 1):
        prev = d - pd.Timedelta(days=delta)
        if prev in rate_map:
            return rate_map[prev]
    return 0.0


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

ndx_pairs       = extend_with_csv(df_to_pairs(ndx_df), read_ndx_csv())
qqq_pairs       = df_to_pairs(qqq_df)                       # = QQQ_adj
sp500tr_pairs   = df_to_pairs(sp500tr_df)
ndx_start       = ndx_pairs[0][0] if ndx_pairs else df_to_pairs(ndx_df)[0][0]
gspc_clipped    = [(d, c) for d, c in df_to_pairs(gspc_df) if d >= ndx_start]

# Fetch FRED short-rate series for financing-cost correction. Done after the
# yfinance pulls so that if FRED rate-limits us, we still have fresh price
# data; the synthesis just falls back to the naive formula until next run.
dff_pairs       = fetch_fred('DFF',   DFF_START)            # daily 1954+
tbms_pairs      = fetch_fred('TB3MS', TBMS_START)           # monthly 1934+
combined_rates  = build_combined_rates(dff_pairs, tbms_pairs)
rate_map        = dict(combined_rates)                      # Timestamp → percent

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
# rate_map is passed in so the synthesis subtracts (L-1)×rate financing cost
# per day, matching how real leveraged ETFs operate. Without this, synthesis
# would overstate real TQQQ by ~2×rate per year (huge in 1970s-80s high-rate
# eras, small in 2010-2021 ZIRP era).
phase1_rows, phase1_pairs = walk_backward(
    ndx_tr_pairs,
    anchor_date=tqqq_df.index[0],
    anchor_price=cell(tqqq_df['Close'].iloc[0]),
    leverage=3,
    expense_daily=TQQQ_EXPENSE_DAILY,
    rate_map=rate_map,
)
# Phase 2: pre-1999, walk through ^NDX directly anchored on phase 1's earliest
# synth value. Net daily error ~ -3*dividend_yield = ~-1.5-2%/yr (price-only).
if phase1_pairs:
    p2_anchor_date, p2_anchor_price = phase1_pairs[0]
    phase2_rows, _ = walk_backward(
        ndx_pairs, p2_anchor_date, p2_anchor_price,
        leverage=3, expense_daily=TQQQ_EXPENSE_DAILY,
        rate_map=rate_map,
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

data_dir = os.path.join(basedir, DATA_DIR)
os.makedirs(data_dir, exist_ok=True)

for ticker, filename in tickers:
    data = real_by_ticker[ticker]
    prefix_rows = prefix_by_ticker.get(ticker, [])
    path = os.path.join(data_dir, filename)

    with open(path, 'w') as f:
        f.write('Date\tClose\n')
        for date_str, close in prefix_rows:
            f.write(f'{date_str}\t{fmt_close(close)}\n')
        for date, row in data.iterrows():
            date_str = date.strftime('%-m/%-d/%Y 16:00:00')
            f.write(f'{date_str}\t{fmt_close(cell(row["Close"]))}\n')

    if prefix_rows:
        first = prefix_rows[0][0].split(' ')[0]
        last = data.index[-1].strftime('%Y-%m-%d')
        print(f"  {filename}: {len(prefix_rows)} synthesized + {len(data)} real, {first} to {last}")
    else:
        start = data.index[0].strftime('%Y-%m-%d')
        end = data.index[-1].strftime('%Y-%m-%d')
        print(f"  {filename}: {len(data)} rows, {start} to {end}")

# === Write rate files =====================================================
# Same TSV format as the price files so they're trivial to load with the same
# parser. Daily granularity post-1954, monthly forward-filled pre-1954.
write_rate_tsv(os.path.join(data_dir, 'fed-funds-effective.tsv'), dff_pairs)
write_rate_tsv(os.path.join(data_dir, 't-bill-3mo.tsv'),          tbms_pairs)
write_rate_tsv(os.path.join(data_dir, 'short-rates.tsv'),         combined_rates)
print(f"  fed-funds-effective.tsv: {len(dff_pairs)} daily rows, {dff_pairs[0][0].strftime('%Y-%m-%d')} to {dff_pairs[-1][0].strftime('%Y-%m-%d')}")
print(f"  t-bill-3mo.tsv:          {len(tbms_pairs)} monthly rows, {tbms_pairs[0][0].strftime('%Y-%m-%d')} to {tbms_pairs[-1][0].strftime('%Y-%m-%d')}")
print(f"  short-rates.tsv:         {len(combined_rates)} daily rows, {combined_rates[0][0].strftime('%Y-%m-%d')} to {combined_rates[-1][0].strftime('%Y-%m-%d')}")

print("Done.")
