#!/usr/bin/env bash
# ============================================================================
# FEED SERVER SETUP (runs once, as root, from the EC2 "user data" box when the
# separate sniper feed server is launched).
#
# Plain English:
#   This small server exists only to read Robinhood's sequencer feed from its
#   own IP address, so it never competes with the arb bot's server.
#     1. Downloads the sniper build (public GitHub branch "sniper-bin").
#     2. Tells the auto-run to run ONLY the feed reader here (MODES=feed-watch)
#        and to publish its report as a text page on port 8080. The AWS
#        firewall lets only the main server read that page.
#     3. Adds the auto-run to cron (every 2 min) and starts it.
#   No keys, no GitHub token, no node keys: nothing secret lives here.
# ============================================================================
set -u
U=ubuntu
H=/home/$U
apt-get update -qq && apt-get install -y -qq git cron python3 >/dev/null
sudo -u $U git clone -q --branch sniper-bin --single-branch https://github.com/rankine-labs/multichain-arb-engine.git $H/sniper-bin
chmod +x $H/sniper-bin/sniper
printf 'MODES=feed-watch\nPUBLISH_PORT=8080\n' > $H/.sniper-cron.conf
chown $U:$U $H/.sniper-cron.conf && chmod 600 $H/.sniper-cron.conf
( sudo -u $U crontab -l 2>/dev/null | grep -v sniper-auto-run; echo "*/2 * * * * bash $H/sniper-bin/deploy/sniper-cron.sh >> $H/sniper-bin/cron.log 2>&1 # sniper-auto-run" ) | sudo -u $U crontab -
sudo -u $U bash $H/sniper-bin/deploy/sniper-cron.sh >> $H/sniper-bin/cron.log 2>&1
echo "feed server ready"
