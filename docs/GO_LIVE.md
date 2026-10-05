# Going live on Robinhood: checklist

The bot runs in **shadow mode** until every step below is done. It can't switch
itself to live: live sending needs four settings that only you add to `.env`.

## 0. Before anything

- [ ] **Outside review of the contract** (`contracts/src/ArbExecutor.sol`). Someone
      independent should read it before real money touches it.
- [ ] **Cold wallet** (Ledger or Trezor). It deploys the contract and becomes the
      owner forever: it alone can withdraw profits, change the bot wallet, and
      approve loan pools.
- [ ] **New hot wallet for the bot** (a fresh key, used for nothing else). It only
      pays gas. Trades use flash loans, so it never holds trading money.
- [ ] Rival timing in the hourly reports looks competitive ("rivals X ms vs ours Y ms").

## 1. Get the loan-pool list

GitHub, then **Actions**, then **Live probe**, then **Run workflow**, with `only` = `lenders`.
The result (about 10 minutes) ends with a line:

```
FLASH_LENDERS=0xPool1,0xPool2,...
```

Copy that list. You use it twice (steps 2 and 4).

## 2. Deploy the contract (from the cold wallet)

On any computer with Foundry installed and the repo checked out:

```bash
cd contracts
EXECUTOR=0xYourBotHotWallet \
FLASH_LENDERS=0xPool1,0xPool2,... \
forge script script/Deploy.s.sol \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --ledger --sender 0xYourColdWallet --broadcast
```

- Use `--trezor` instead of `--ledger` for a Trezor.
- Run it once **without** `--broadcast` first: it only prints what it would do.
- It prints `ArbExecutor deployed at: 0x...`. Keep that address.

The cold wallet needs a little ETH on Robinhood Chain to pay for the deploy.

## 3. Fund the bot wallet

Send **$20 to $50 of ETH** (Robinhood Chain) to the bot hot wallet. Trades cost
cents in gas. If it runs low, Telegram sends a LOW GAS warning.

## 4. Settings on the server

Add these lines to `~/multichain-arb-engine/.env`:

```
ARB_EXECUTOR_ROBINHOOD=0xTheContractAddressFromStep2
FLASH_LENDERS_ROBINHOOD=0xPool1,0xPool2,...      # same list as step 2
BOT_PRIVATE_KEY=0xTheBotHotWalletKey
MAX_TRADE_USD=1000          # start small
DAILY_LOSS_CAP_USD=25       # stop for the day after $25 lost
EXECUTION_ENABLED=true
LIVE_SEND_CONFIRM=yes-real-money
```

Then restart:

```bash
pm2 restart dex-arb-shadow --update-env
```

## 5. Check it's live

`pm2 logs dex-arb-shadow --lines 50 | grep fire` should show:

```
[fire] robinhood sender ready (LIVE from 0xYourBotHotWallet)
```

Every live trade then posts to Telegram: TRADE WON (profit, gas) or
TRADE REVERTED (lost the race; gas only).

## STOP IMMEDIATELY (no restart needed)

```bash
touch ~/multichain-arb-engine/data/KILL
```

Every trade checks for this file. To resume: `rm ~/multichain-arb-engine/data/KILL`.

To turn live mode off completely, set `EXECUTION_ENABLED=false` in `.env`, then
`pm2 restart dex-arb-shadow --update-env`.

## Built-in safety limits (always on)

| Limit | Default | Setting |
|---|---|---|
| Max trade size | $5,000 | `MAX_TRADE_USD` |
| Daily loss cap (gas on lost races + any losses) | $25 | `DAILY_LOSS_CAP_USD` |
| Max sends per minute | 6 | `MAX_SENDS_PER_MIN` |
| Only vetted tokens (the watched top pairs) | on | - |
| Only approved loan pools | on | `FLASH_LENDERS_ROBINHOOD` |
| Trade deadline | latest block + 3 (~0.3 s) | - |
| Contract reverts unless the trade ends in profit | always | - |

## Taking profits out (cold wallet)

Profits stay in the contract. The owner withdraws:

```bash
cast send 0xContract "withdraw(address,address,uint256)" 0xToken 0xYourColdWallet AMOUNT \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --ledger --from 0xYourColdWallet
```

## If the bot key might be leaked

The bot key can't withdraw anything. Still, replace it from the cold wallet:

```bash
cast send 0xContract "setExecutor(address)" 0xNewBotWallet \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --ledger --from 0xYourColdWallet
```

Then put the new key in `BOT_PRIVATE_KEY` and restart.

## Scaling up

Only after a few days of live results in Telegram:
1. More wins than reverts, and profit above gas: raise `MAX_TRADE_USD` step by step ($1k, then $2.5k, then $5k).
2. Many reverts: we're losing races. Check the rival timing before spending more on gas.
