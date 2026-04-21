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

tickers = [
    ('QQQ',  'simulation_tqqq_qqq - qqq.tsv'),
    ('TQQQ', 'simulation_tqqq_qqq - tqqq.tsv'),
    ('SPY',  'simulation_tqqq_qqq - spy.tsv'),
]

for ticker, filename in tickers:
    print(f"Fetching {ticker}...")
    data = yf.download(ticker, period="max", auto_adjust=True, progress=False)

    path = os.path.join(basedir, filename)
    with open(path, 'w') as f:
        f.write('Date\tClose\n')
        for date, row in data.iterrows():
            date_str = date.strftime('%-m/%-d/%Y 16:00:00')
            close_raw = row['Close']
            close_val = float(close_raw.iloc[0]) if hasattr(close_raw, 'iloc') else float(close_raw)
            f.write(f'{date_str}\t{round(close_val, 2)}\n')

    start = data.index[0].strftime('%Y-%m-%d')
    end = data.index[-1].strftime('%Y-%m-%d')
    print(f"  {filename}: {len(data)} rows, {start} to {end}")

print("Done.")
