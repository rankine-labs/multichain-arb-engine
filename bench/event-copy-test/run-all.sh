#!/bin/bash
# Runs every pool type and copy variant. Usage: ./run-all.sh <seed> [ops]
# Two runs at a time (each run uses its own pair of practice chains).
cd "$(dirname "$0")"
SEED=${1:-1}; OPS=${2:-330}
mkdir -p logs
(
  node runner.js v2 $OPS $SEED > logs/v2-s$SEED.log 2>&1
  node runner.js v3 $OPS $SEED replay > logs/v3-replay-s$SEED.log 2>&1
  node runner.js v3 $OPS $SEED fields > logs/v3-fields-s$SEED.log 2>&1
  node runner.js pancake $OPS $SEED replay > logs/pancake-replay-s$SEED.log 2>&1
  node runner.js pancake $OPS $SEED fields > logs/pancake-fields-s$SEED.log 2>&1
  node runner.js solidly $OPS $SEED > logs/solidly-s$SEED.log 2>&1
) &
(
  node runner.js algebra $OPS $SEED replay > logs/algebra-replay-s$SEED.log 2>&1
  node runner.js algebra $OPS $SEED fields > logs/algebra-fields-s$SEED.log 2>&1
  node runner.js algebra $OPS $SEED fields-plugin > logs/algebra-fields-plugin-s$SEED.log 2>&1
  node runner.js v4 $OPS $SEED replay > logs/v4-replay-s$SEED.log 2>&1
  node runner.js v4 $OPS $SEED fields > logs/v4-fields-s$SEED.log 2>&1
) &
wait
