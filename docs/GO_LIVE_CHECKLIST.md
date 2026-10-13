# Friday go-live checklist (Robinhood Chain)

Short, in order. Background and full commands: [GO_LIVE.md](GO_LIVE.md).
**Rudy** = anything with a wallet, a key or money. **Claude** = checks, logs, reports.
Claude never touches keys, never deploys, never sends a transaction.

## 1. What "live" means

Today the bot runs as practice (`dex-arb-shadow` under pm2). It finds trades,
signs them with a throwaway key and never sends. Live means the bot signs with
the real hot wallet and sends 2-pool trades to our own ArbExecutor contract.
The contract cancels any trade that does not end in profit, so a lost race
costs only gas (cents). Loops stay practice only (section 6).

## 2. Before Friday (have these ready)

**Wallets**
- [ ] Cold wallet (Ledger or Trezor). Deploys the contract and becomes the
      owner. Only it can withdraw, change the bot wallet, or approve loan pools.
- [ ] Hot wallet: a brand new key, used for nothing else. It only pays gas.
      It must be a different address from the cold wallet (the contract
      refuses to deploy otherwise: `OwnerIsExecutor`).

**Funds**
- [ ] Cold wallet: a little ETH on Robinhood Chain to pay for the deploy.
- [ ] Hot wallet: $20 to $50 of ETH on Robinhood Chain (gas only).
- [ ] Own money for the contract: about $1,000 USDG + $300 WETH, ready to send
      after the deploy.
      USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`,
      WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`.

**Paid node** (see [NODE_PROVIDERS.md](NODE_PROVIDERS.md))
- [ ] Chainstack or QuickNode plan for Robinhood Chain (chain id 4663).
- [ ] In `.env`: `CHECK_RPC_MAIN`, `CHECK_RPC_MAIN_DAILY`, optional
      `CHECK_RPC_FALLBACK` / `CHECK_RPC_FALLBACK_DAILY`, optional `BLOCK_READER_WSS`.
- [ ] After restart the log shows `[sim] robinhood: checks on <Provider>` and the
      `[blockreader]` line says `live`. (Claude checks.)
- Trades are sent straight to the Robinhood sequencer by default
  (`ROBINHOOD_SEND_RPC` unset). Leave it that way.

**Practice numbers to confirm** (Claude reads the status page and hourly
Telegram report from the last few days, Rudy signs off)

| Line | Good looks like |
|---|---|
| `Real-chain test runs: X profitable · Y losing · Z would fail` | profitable well above zero every day |
| `Race check: N would have won · M lost to a faster bot` | "would have won" is not zero |
| `Rivals: ... theirs X ms median vs ours Y ms` | ours in the same range as theirs |
| `Dry run, would have earned` | positive, and the "verified" part is not zero |
| `Limits in use:` | matches what we set (check again after step 6) |
| `Errors this window` | none, or only known harmless ones |

- [ ] ArbSys check passed recently: GitHub, Actions, **Live probe**, `only=arbsys`
      says "ArbSys deadline check works". (Claude runs it.)
- [ ] **No merges to main on Friday** while live is being switched on. Every
      merge auto-deploys and restarts the live bot.

## 3. Go-live steps (in this exact order)

**Step 1. Fresh loan-pool list.** WHO: Claude
- GitHub, Actions, **Live probe**, Run workflow, `only` = `lenders` (about 10 min).
- Copy the `FLASH_LENDERS=0x...,0x...` line. Used in step 2 and step 5.
- The script only picks Uniswap / PancakeSwap / Ramses V3 pools, so no
  Algebra pools (Alandale, KittenSwap). Claude double-checks this.

**Step 2. Deploy the contract from the cold wallet.** WHO: Rudy (Claude reads the output)
- Script: `contracts/script/Deploy.s.sol`. Contract: `contracts/src/ArbExecutor.sol`.
- The one constructor arg is the hot wallet (`EXECUTOR`). The script also, in
  the same run: approves every `FLASH_LENDERS` pool (`setFlashPool`) and turns
  on Uniswap V4 (`setV4` with Robinhood's PoolManager
  `0x8366a39CC670B4001A1121B8F6A443A643e40951` and WETH). Nothing else to set.
- Run once WITHOUT `--broadcast` (dry run), then again WITH it:

```bash
cd contracts
EXECUTOR=0xHotWallet FLASH_LENDERS=0xPool1,0xPool2,... \
forge script script/Deploy.s.sol \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --ledger --sender 0xColdWallet --broadcast
```

- Use `--trezor` for a Trezor. Save the printed `ArbExecutor deployed at: 0x...`.
- Verify (Claude can run these, read only):

```bash
R=https://rpc.mainnet.chain.robinhood.com
cast call 0xContract "owner()(address)" --rpc-url $R          # = cold wallet
cast call 0xContract "executor()(address)" --rpc-url $R       # = hot wallet
cast call 0xContract "v4PoolManager()(address)" --rpc-url $R  # = 0x8366...0951
cast call 0xContract "flashPools(address)(bool)" 0xPool1 --rpc-url $R  # = true
```

**Step 3. Gas for the hot wallet.** WHO: Rudy
- Send $20 to $50 of ETH (Robinhood Chain) to the hot wallet.

**Step 4. Own money into the contract.** WHO: Rudy
- Plain token transfer from your wallet to the contract address: about $1,000
  USDG and $300 WETH. There is no deposit function; a normal transfer is it.
- The bot reads these balances every 15 s when live and uses own money only
  if the contract really holds enough. Otherwise it borrows from an approved pool.
- Verify: `cast call <USDG or WETH> "balanceOf(address)(uint256)" 0xContract --rpc-url $R`

**Step 5. Settings on the server.** WHO: Rudy pastes secrets himself
- Edit `~/multichain-arb-engine/.env`. Names only below; never paste values in chat.

| Name | What goes in it |
|---|---|
| `ARB_EXECUTOR_ROBINHOOD` | contract address from step 2 |
| `FLASH_LENDERS_ROBINHOOD` | the same list used in step 2 |
| `BOT_PRIVATE_KEY` | hot wallet key (secret) |

**Step 6. First-day limits.** WHO: Rudy adds, Claude confirms in the `[limits]` line
- Plain numbers only, no commas (`5,000` blocks every send: `BAD SETTING(S)`).
- Important: if `MAX_TRADE_USD` is missing the code uses **$20,000**. Always set it.

```
MAX_TRADE_USD=250            # biggest trade (code default 20,000)
OWN_MONEY_MAX_USD=250        # own-money trade size cap (code default 2,000)
AUTO_VET_MAX_TRADE_USD=100   # cap on newly auto-vetted coins (default 300)
MIN_EXEC_NET_USD=0.25        # only send if expected profit after costs >= $0.25 (default 0.10)
DAILY_LOSS_CAP_USD=10        # stop sending for the day after $10 lost (default 25)
MAX_SENDS_PER_MIN=3          # default 6
```

- Leave `RH_FUNDING` unset (own money first, loans when own money is short).
- These are suggested starting values (Claude's pick, small on purpose), not
  code defaults. Note `MAX_TRADE_USD` also caps practice sizing, so practice
  numbers will drop a bit. That is expected.

**Step 7. Flip the switch.** WHO: Rudy
- Add both lines. Live needs ALL of: these two, `BOT_PRIVATE_KEY`, `ARB_EXECUTOR_ROBINHOOD`.

```
EXECUTION_ENABLED=true
LIVE_SEND_CONFIRM=yes-real-money
```

**Step 8. Restart.** WHO: Rudy (or Claude on the server)
- `pm2 restart dex-arb-shadow --update-env`

**Step 9. Confirm it is live.** WHO: Claude
- `pm2 logs dex-arb-shadow --lines 80 | grep -E "fire|limits|safety"` must show:
  - `[fire] robinhood sender ready (LIVE from 0xHotWallet)`
  - `[fire] live checks passed: chain, executor role, lenders, ArbSys deadline`
  - `[limits]` with the step 6 numbers
- Must NOT show: `LIVE CHECKS FAILED`, `BAD SETTING(S)`, `LOW GAS`,
  or `EXECUTION_ENABLED=true but LIVE_SEND_CONFIRM / BOT_PRIVATE_KEY not set`.

## 4. First hour and first day

Watch Telegram. Every live trade posts one of:
- `TRADE WON`: profit, gas, and the expected profit.
- `TRADE REVERTED`: lost the race or price moved. Gas only.

**First hour (Claude watches logs and Telegram, Rudy watches Telegram)**
- [ ] At least one trade sent (if none in an hour, Claude checks why in the logs).
- [ ] Gas per trade in cents, not dollars.
- [ ] `TRADE WON` profit roughly near "expected", not far below.
- [ ] Contract USDG and WETH balances not lower than what you put in (step 4 check).

**First day**
- [ ] Wins vs reverts. More wins than reverts, or at least profit above gas.
- [ ] Hot wallet ETH still above $10.
- [ ] Status page `Limits in use` still shows the step 6 numbers.

**Stop numbers (any one = go to section 5)**
- `LIVE CHECKS FAILED`, `BAD SETTING(S)` or `LOW GAS` in Telegram or logs.
- 10 reverts in a row with no win.
- Daily loss cap reached ($10). The bot stops itself until midnight UTC; do not
  raise the cap the same day. Look first.
- Contract balance of USDG or WETH lower than deposited.
- Any trade or log line you do not understand. Stop first, ask after.

## 5. Stop and rollback

Fastest first:

1. **Pause sends, no restart** (Rudy or Claude on the server):
   `touch ~/multichain-arb-engine/data/KILL`. Every trade checks it.
   Resume with `rm ~/multichain-arb-engine/data/KILL`.
2. **On-chain kill switch** (Rudy, cold wallet). No bot wallet can trade after this:

```bash
cast send 0xContract "setExecutor(address)" 0x0000000000000000000000000000000000000000 \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --ledger --from 0xColdWallet
```

   Resume later with `setExecutor(<hot wallet>)`.
3. **Back to practice** (Rudy): set `EXECUTION_ENABLED=false` in `.env`, then
   `pm2 restart dex-arb-shadow --update-env`.
4. **Take the money out** (Rudy, cold wallet). Tokens: `withdraw(address,address,uint256)`.
   Native ETH: `withdrawEth(address,uint256)`.

```bash
cast send 0xContract "withdraw(address,address,uint256)" 0xToken 0xColdWallet AMOUNT \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --ledger --from 0xColdWallet
```

- Hot key might be leaked: `setExecutor(<new hot wallet>)` from the cold wallet,
  put the new key in `BOT_PRIVATE_KEY`, restart. The hot key cannot withdraw anything.

## 6. Loops are NOT live on Friday

Loop trader v1 cannot send. It is never given the sender, even with
`EXECUTION_ENABLED=true`. `LOOP_TRADER=1` is safe to leave on (practice only).
Needed before loops can go live (from [LOOP_TRADER.md](LOOP_TRADER.md)):
- A contract test with 3+ hops (mixed V2 + V3 + V4).
- A Robinhood fork test of a real loop (e.g. WETH/DJT/PONS/USDG).
- A separate loop send path with its own switch, behind the same safety gate.
- Owner approval of a few days of loop practice numbers.
- Own money in WETH/USDG (a flash lender must not sit on the loop).

Information only: gas per loop trade measured in the PR #116 fork tests:
3 pools 502k, 4 pools 646k, 5 pools 758k.

## 7. One-page tick box

**Before Friday**
- [ ] Cold wallet ready, with a little ETH
- [ ] New hot wallet, different from cold, with $20 to $50 ETH
- [ ] $1,000 USDG + $300 WETH ready
- [ ] Paid node in `.env`, `[sim]` and `[blockreader]` lines look right
- [ ] Practice numbers signed off
- [ ] ArbSys probe passed
- [ ] No merges planned for Friday

**Friday**
- [ ] 1. Lender list from Live probe (Claude)
- [ ] 2. Deploy from cold wallet, dry run first, save address (Rudy)
- [ ] 2b. `owner`, `executor`, `v4PoolManager`, `flashPools` verified (Claude)
- [ ] 3. Hot wallet gas sent (Rudy)
- [ ] 4. USDG + WETH sent to contract, balances verified (Rudy, Claude)
- [ ] 5. `ARB_EXECUTOR_ROBINHOOD`, `FLASH_LENDERS_ROBINHOOD`, `BOT_PRIVATE_KEY` in `.env` (Rudy)
- [ ] 6. First-day limits in `.env` (Rudy)
- [ ] 7. `EXECUTION_ENABLED=true`, `LIVE_SEND_CONFIRM=yes-real-money` (Rudy)
- [ ] 8. `pm2 restart dex-arb-shadow --update-env`
- [ ] 9. `LIVE from`, `live checks passed`, `[limits]` correct (Claude)
- [ ] First hour checks done
- [ ] First day checks done

**If anything looks wrong**
- [ ] `touch data/KILL`, then think
- [ ] Serious: `setExecutor(0x0)` from cold wallet
- [ ] `EXECUTION_ENABLED=false` + restart
- [ ] `withdraw` / `withdrawEth` to cold wallet
