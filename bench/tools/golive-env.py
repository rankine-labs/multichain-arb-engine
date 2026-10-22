# Sets the fast-check (copy 2) go-live lines in the bot's .env. Backs up first; replaces existing lines, appends missing ones. Prints only the keys it set.
import os, shutil, time
p = os.path.expanduser('~/multichain-arb-engine/.env')
shutil.copy2(p, p + '.bak-golive-' + time.strftime('%Y%m%d-%H%M%S'))
want = {'LOCAL_SIM': 'on', 'LOCAL_SIM_CONFIRM': 'yes-fast-check', 'ARBSIM_SOURCE': 'pool-events',
        'ARBSIM_NODE_RPS': '60', 'ARBSIM_COPY2_INFLIGHT': '16', 'ARBSIM_NODE_DAILY_CAP': '60000'}
lines = open(p).read().split('\n'); seen = set(); out = []
for l in lines:
    k = l.split('=', 1)[0].strip().replace('export ', '')
    if k in want:
        if k in seen: continue
        out.append(f'{k}={want[k]}'); seen.add(k)
    else:
        out.append(l)
if out and out[-1] == '': out.pop()
for k, v in want.items():
    if k not in seen: out.append(f'{k}={v}')
open(p, 'w').write('\n'.join(out) + '\n')
print('set:', ', '.join(f'{k}={v}' for k, v in want.items()))
