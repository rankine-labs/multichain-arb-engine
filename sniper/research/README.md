# Robinhood rule research (Python, read-only)

Scripts used to search for an entry/exit rule on Robinhood Chain swap data
recorded by `sniper rhc-probe`. They read `swaps.jsonl` from a probe folder.

- `sweep.py`          shared maths: prices, signals (crowd / single big buy),
                      exits, exact own-impact (concentrated liquidity),
                      one-trade-at-a-time P&L
- `run_sweep.py`      rank rules on a training slice, check on unseen slices
- `run_exact.py`      dollars with our real size pushed through the pool
- `run_fixed.py`      one locked rule across quarters of a run
- `check_honeypot.py` do profits come from pools nobody sells in?
- `check_baseline.py` signal vs RANDOM entries in the same pools; V3 vs V4
- `check_v3.py`       same, V3 pools only (fully modelled)
- `check_night.py`    same on the long overnight run (% returns)

Key lesson recorded in the project notes: always compare a rule with random
entries in the same pools. Raw paper profits on Robinhood were mostly not
from the trigger.
