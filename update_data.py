#!/usr/bin/env python3
"""
Fetches the latest daily closing prices for QQQ, TQQQ, and SPY from Yahoo Finance
and writes them as TSV files consumed by index.html.

Prices are dividend- and split-adjusted (auto_adjust=True) so all three datasets
use the same adjustment basis, keeping comparisons fair.

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

# TQQQ expense ratio used when synthesizing pre-2010 prices from QQQ daily returns.
EXPENSE_DAILY = 0.0088 / 252

tickers = [
    ('QQQ',  'simulation_tqqq_qqq - qqq.tsv'),
    ('TQQQ', 'simulation_tqqq_qqq - tqqq.tsv'),
    ('SPY',  'simulation_tqqq_qqq - spy.tsv'),
]


def cell(value):
    return float(value.iloc[0]) if hasattr(value, 'iloc') else float(value)


def synthesize_tqqq_prefix(qqq_df, tqqq_df):
    """Walk QQQ daily returns backward from the first real TQQQ price to fabricate
    pre-IPO TQQQ closes (3x daily QQQ return minus expense). Returns a list of
    (date_str, close) for every QQQ trading day strictly before TQQQ's real start."""
    real_start_date = tqqq_df.index[0]
    real_start_price = cell(tqqq_df['Close'].iloc[0])
    pre = qqq_df[qqq_df.index < real_start_date]
    n = len(pre)
    if n == 0:
        return []
    # yfinance returns MultiIndex columns even for single tickers, so iterating
    # `pre['Close']` yields column labels ('QQQ') instead of prices. Go via
    # iterrows like the main write loop already does.
    closes = [cell(row['Close']) for _, row in pre.iterrows()]
    synth = [0.0] * n
    synth[-1] = real_start_price
    for i in range(n - 1, 0, -1):
        qret = (closes[i] - closes[i - 1]) / closes[i - 1]
        synth[i - 1] = max(synth[i] / (1 + 3 * qret - EXPENSE_DAILY), 0)
    rows = []
    for i, date in enumerate(pre.index):
        date_str = date.strftime('%-m/%-d/%Y 16:00:00')
        rows.append((date_str, synth[i]))
    return rows


fetched = {}
for ticker, filename in tickers:
    print(f"Fetching {ticker}...")
    fetched[ticker] = yf.download(ticker, period="max", auto_adjust=True, progress=False)

for ticker, filename in tickers:
    data = fetched[ticker]
    path = os.path.join(basedir, filename)
    decimals = 4 if ticker == 'TQQQ' else 2
    prefix_rows = synthesize_tqqq_prefix(fetched['QQQ'], data) if ticker == 'TQQQ' else []

    with open(path, 'w') as f:
        f.write('Date\tClose\n')
        for date_str, close in prefix_rows:
            f.write(f'{date_str}\t{round(close, decimals)}\n')
        for date, row in data.iterrows():
            date_str = date.strftime('%-m/%-d/%Y 16:00:00')
            f.write(f'{date_str}\t{round(cell(row["Close"]), decimals)}\n')

    if prefix_rows:
        first_synth = prefix_rows[0][0].split(' ')[0]
        last_real = data.index[-1].strftime('%Y-%m-%d')
        print(f"  {filename}: {len(prefix_rows)} synthesized + {len(data)} real, {first_synth} to {last_real}")
    else:
        start = data.index[0].strftime('%Y-%m-%d')
        end = data.index[-1].strftime('%Y-%m-%d')
        print(f"  {filename}: {len(data)} rows, {start} to {end}")

print("Done.")
