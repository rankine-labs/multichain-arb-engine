import { SeedPair } from '../core/seedPairs';

// ============================================================================
// BACKUP START LIST -- Robinhood top 20 pairs (chain-wide scan, 2026-10-05)
//
// Only used when the server has no saved list yet (fresh machine or data/
// deleted). Normally the bot uses data/robinhood-top-pairs.json, refreshed
// after every good scan. To refresh this backup: GitHub -> Actions ->
// Live probe -> Run workflow with only = seed, then paste the result here.
// ============================================================================
export const ROBINHOOD_SEED_PAIRS: SeedPair[] = [
  { a: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', b: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', label: 'WETH/USDG' },
  { a: '0x020bfC650A365f8BB26819deAAbF3E21291018b4', b: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', label: 'CASHCAT/WETH' },
  { a: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', b: '0x39dBED3a2bd333467115dE45665cC57F813C4571', label: 'WETH/PONS' },
  { a: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', b: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', label: 'SPCX/USDG' },
  { a: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', b: '0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e', label: 'USDG/GLD' },
  { a: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', b: '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5', label: 'USDG/SGOV' },
  { a: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', b: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', label: 'USDG/NVDA' },
  { a: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', b: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', label: 'WETH/NVDA' },
  { a: '0x1b0E319c6A659F002271B69dB8A7df2F911c153E', b: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', label: 'GME/USDG' },
  { a: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', b: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', label: 'SPY/USDG' },
  { a: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', b: '0x8005d266423c7ea827372c9c864491e5786600ea', label: 'USDG/LLY' },
  { a: '0x020bfC650A365f8BB26819deAAbF3E21291018b4', b: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', label: 'CASHCAT/USDG' },
  { a: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', b: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', label: 'USDG/AAPL' },
  { a: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', b: '0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31', label: 'WETH/VIRTUAL' },
  { a: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', b: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35', label: 'USDG/META' },
  { a: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', b: '0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8', label: 'USDG/RBLX' },
  { a: '0x43B07D15cE533bEc5476d70C22a78a1B2B662155', b: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', label: 'MRNA/USDG' },
  { a: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', b: '0xec262a75e413fAfD0dF80480274532C79D42da09', label: 'WETH/MSTR' },
  { a: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', b: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', label: 'TSLA/USDG' },
  { a: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', b: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', label: 'WETH/SPY' },
];
