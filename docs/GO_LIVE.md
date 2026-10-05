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

Last result (2026-10-04, 35 pools covering 19 tokens, deepest WETH/USDG ~$18M).
Re-run the probe right before deploying in case pools have changed:

```
FLASH_LENDERS=0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca,0xA70fc67C9F69da90B63a0e4C05D229954574E313,0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3,0xd42A491087a15E5afd51FEb3606066Cc152d2b09,0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA,0xEd50bDeeA8aDC232f159486192a4157281D722ff,0xc61284332117c3FB23A2A56cceFFD07F7aF60029,0xEb07d9587eFD1778dFb9c385Ec43EF6d5F9fE401,0x7A6A053eCCf1446A2633E05aA6D40D09381997ec,0xBA2f1ed4cEB2169D538d1e614D847E83C5A55913,0xfAb520051f96F4D2a32c22B6a3dD7fFfdf231bFe,0x6Ba50150B17Ffd0972915Aaf04fFd5E8f4Fa49b4,0x62AB521f71431f78ac374CdbadC6cda3c8916b6C,0xE9713f453aDB9245B19559790c96F470a18F2fDF,0xE2b46c905E12Ab8E2f864e4821a4325884C1B126,0x38453c115607463Ac284820Ce959831042f3Df4E,0x47A2a145308d55eaa957920876Ab626730eAF90b,0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D,0x783C9bbB765047CFdD2b84b92b2Ca9F11D34b7Ed,0x9cc8c4F6118419A27f113723F1DeA646685Be55F,0x7a11bC7f32AEA2f81E83DA399C70315d9662869C,0xF4274130137eeE20bAD928B593d992716516CEB9,0xF212D02146a897F5F686E9d629F6A73da534324a,0x2ef5945cd5664876b6481FdacFaA2942995a4DA8,0x1BDB8e3A79Cb1a7F228808739311E23098D33d43,0x9664D869540E9D0a76f12C6623946C6D5d201e09,0x78B4382721830f573916858c3fF10f6072D09897,0xB40196272A6d2EB5edF6d93bc4DC39856AD95E0E,0xA34d0667334074DF2d5BfD259e79E6B9cf1fA8Bf,0x107a7Cb40d8665360ba10E59471Af06150A50922,0x960f79D8DfEC7F2F0C1b24CdAC6BB9Df1371C6e2,0x70504a6FafdbfB75fE971FAA4dD716e79aC5624c,0x055036F511567711E0b2E127a1a468802bB93065,0xf4ACdAEEB7022862A763C9B1B885e11191c889E3,0xc4f0172D6ac8DD294Dd1137D047d5E1893760236
```

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
- It also switches on Uniswap V4 trading (Robinhood's PoolManager + WETH) and
  prints the PoolManager it set. Only V4 pools without hooks can ever be traded.

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
