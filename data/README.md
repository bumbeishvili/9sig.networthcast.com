# data/

Daily closing-price series consumed by `index.html`. Each file is a tab-separated `Date\tClose` table with a single header row.

| File | Contents |
| --- | --- |
| `simulation_tqqq_qqq - qqq.tsv` | QQQ — real (yfinance auto-adjusted) from 1999-03-10, synthesized from extended `^NDX` for earlier dates. |
| `simulation_tqqq_qqq - tqqq.tsv` | TQQQ — real from 2010-02-11, synthesized via derived NDX-TR (1999–2010) and `^NDX` (pre-1999). |
| `simulation_tqqq_qqq - spy.tsv` | SPY — real from 1993-01-29, synthesized via `^SP500TR` (1988–1993) and `^GSPC` (pre-1988). |

All files are produced by `update_data.py` at the repo root. Don't hand-edit — the automated GitHub Actions job at `.github/workflows/update-data.yml` overwrites them on every weekday refresh. See the root `README.md` for refresh details and the docstring in `update_data.py` for the synthesis logic and known biases.
