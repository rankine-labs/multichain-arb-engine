#!/usr/bin/env bash
# What the profit-measure workflow runs (edited between runs).
# Full run: 24-hour window, receipts up to 190 min, census up to 45 min.
set -u
npx tsc -p tsconfig.pm.json
PM_HOURS=24 PM_BATCH=30 PM_RECEIPT_MIN=190 PM_CENSUS_MIN=45 node --max-old-space-size=6000 .scripts-build/scripts/profit-measure/measure.js
node scripts/profit-measure/report.mjs results/profit-measure > /dev/null && echo "report written"
