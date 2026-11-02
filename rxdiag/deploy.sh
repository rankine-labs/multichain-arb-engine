#!/usr/bin/env bash
# Deploy helper for PR #278 (stock tick maths). Holds the shared deploy lock
# ~/rx/deploy.lock for the whole deploy, so helpers never deploy over each other.
# 1) wait for the lock  2) wait until main moves past OLD_MAIN (our merge)
# 3) touch DEPLOY_ALLOW_LIVE  4) wait for "DEPLOYED <sha>" (or a failure) in the deploy log.
S=~/rx/stockpx/deploy.status; APP=/home/ubuntu/multichain-arb-engine; OLD_MAIN="$1"
echo "waiting for lock $(date -u +%T)" > $S
# Same convention as the other helpers: the lock is held while the file
# exists (created with noclobber, so only one helper can create it).
GOT=0
for i in $(seq 1 1080); do
  if ( set -o noclobber; echo "stockpx PR278 tick maths $(date -u +%FT%TZ)" > ~/rx/deploy.lock ) 2>/dev/null; then GOT=1; break; fi
  sleep 10
done
[ "$GOT" = 1 ] || { echo "LOCK TIMEOUT $(date -u +%T)" >> $S; exit 1; }
trap 'rm -f ~/rx/deploy.lock' EXIT
echo "LOCKED $(date -u +%T)" >> $S
NEW=""
for i in $(seq 1 180); do
  NEW=$(git -C $APP ls-remote origin refs/heads/main | cut -c1-40)
  [ -n "$NEW" ] && [ "$NEW" != "$OLD_MAIN" ] && break
  sleep 10
done
[ "$NEW" = "$OLD_MAIN" ] && { echo "main did not move, giving up $(date -u +%T)" >> $S; exit 1; }
SHORT=${NEW:0:7}
echo "main is now $NEW; touching DEPLOY_ALLOW_LIVE $(date -u +%T)" >> $S
LOGSTART=$(stat -c %s $APP/deploy/auto-deploy.log)
touch $APP/DEPLOY_ALLOW_LIVE
for i in $(seq 1 150); do
  NEWLOG=$(tail -c +$((LOGSTART + 1)) $APP/deploy/auto-deploy.log)
  if echo "$NEWLOG" | grep -q "DEPLOYED.*$SHORT"; then
    if echo "$NEWLOG" | grep -q "NOT DEPLOYED.*$SHORT"; then echo "FAILED: NOT DEPLOYED $SHORT $(date -u +%T)" >> $S; break; fi
    echo "DEPLOYED $SHORT $(date -u +%T) running=$(git -C $APP rev-parse --short HEAD)" >> $S; break
  fi
  if echo "$NEWLOG" | grep -qi "roll.*back"; then echo "ROLLBACK seen $(date -u +%T)" >> $S; echo "$NEWLOG" | grep -i "roll" | tail -3 | cut -c1-200 >> $S; break; fi
  sleep 10
done
echo "done, lock released $(date -u +%T)" >> $S
