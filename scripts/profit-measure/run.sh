#!/usr/bin/env bash
# What the profit-measure workflow runs (edited between runs).
# Trial run: 1 hour window, short budgets, to check the pipeline and speed.
set -u
npx tsc -p tsconfig.pm.json
PM_HOURS=1 PM_RECEIPT_MIN=12 PM_CENSUS_MIN=6 node .scripts-build/scripts/profit-measure/measure.js
