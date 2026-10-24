#!/usr/bin/env bash
# What the profit-measure workflow runs (edited between runs).
# Fix-up run: name the V4 pools the 24 h run could not, re-check those trades.
set -u
npx tsc -p tsconfig.pm.json
PM_BATCH=25 PM_INIT_MIN=25 node --max-old-space-size=6000 .scripts-build/scripts/profit-measure/v4fix.js
