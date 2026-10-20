# In-bot simulator: engine speed test (throwaway branch, never merge)

Speed/accuracy test for running ArbExecutor inside the bot (go/no-go #1).
- fixture-maker/grab-live.js: READ ONLY. Turns the bot's real sent trades into test files (state + chain answer).
- fixture-maker/make-offline.js: practice data on a local chain (real Uniswap pool code + live contract code).
- js/, revm/: the two candidate engines and their speed tests.
