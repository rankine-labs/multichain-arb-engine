// ============================================================================
// ROBINHOOD EXTRA VENUES -- the exchanges beyond Uniswap / PancakeSwap /
// Ramses, with FULL addresses and how each one prices a trade.
//
// Plain English:
//   On Oct 8 we found that about half of rival 2-pool wins go through pools
//   made by factories we didn't read. This file names those factories and
//   the other exchanges on Robinhood Chain, says what kind of maths each one
//   uses, and whether our bot may READ prices there and whether it may TRADE
//   there. Trading is OFF for every venue here: `executionEnabled` is the
//   literal type `false`, so turning one on needs a code change and review,
//   never a settings tweak.
//
// Where the addresses come from (no guessing):
//   - the rival-trade probes (Phase 6, runs 37830228775 / 37835060856): the
//     factory() of pools rival bots actually traded through, and
//   - the public DefiLlama volume adapters (github.com/DefiLlama/
//     dimension-adapters, files named in `source`), which read these same
//     contracts every day, and
//   - each project's own documentation where one exists.
//   `onChain` records what the venue probe (scripts/probe-venues.ts) found;
//   a venue is only "verified" once its maths matched real swaps there.
//
// Pricing models:
//   'uniswap-v3'   Uniswap V3 copy: slot0() + liquidity() + fee() (pips)
//   'pancake-v3'   PancakeSwap V3 copy: same reads, PancakeSwap Swap event
//   'slipstream'   Velodrome/Aerodrome CL copy: same first slot0 word, pools
//                  keyed by tick spacing, fee() in pips
//   'algebra'      Algebra Integral copy: globalState() instead of slot0,
//                  dynamic fee (globalState word 2 / fee())
//   'solidly'      Solidly pair (volatile x*y=k or stable curve), fee per pair
//   'v4-hooked'    Uniswap V4 pools with a hook (dynamic fee) on the shared
//                  PoolManager; read like V4, fee from the swap itself
//   'oracle-amm'   price set by an outside price feed, not by the pool's
//                  balances: can't be priced from pool state, only quoted
//   'prop-amm'     a market maker's own contract (quotes change off chain)
//   'singleton'    one contract holds every pool (own pool ids and maths)
// ============================================================================

export type VenueModel =
  | 'uniswap-v3' | 'pancake-v3' | 'slipstream' | 'algebra' | 'solidly'
  | 'v4-hooked' | 'oracle-amm' | 'prop-amm' | 'singleton';

export interface VenueContract {
  role: 'factory' | 'registry' | 'core' | 'swap' | 'retired-factory' | 'pair-config';
  address: string;
}

export interface RobinhoodVenue {
  id: string;
  name: string;
  priority: 'P0' | 'P1' | 'P2';
  model: VenueModel;
  contracts: VenueContract[];
  // Can our bot read a live price from the pool's state (no quote call)?
  priceable: boolean;
  // Trading through our executor contract. Always false here (see header).
  executionEnabled: false;
  // Why it can't be traded by our contract today, in plain words.
  executionBlocker: string;
  source: string[];
  // Filled from the venue probe; see docs/VENUES.md for the run.
  onChain?: { verified: boolean; note: string };
  // Set ONLY when our real executor contract traded this venue's pools on a
  // fork of the live chain (contracts/test/ForkCopyVenues.t.sol, or
  // ForkAlgebraVenues.t.sol for the Algebra venues): both
  // directions, every swap executed, stopped only by our own profit check.
  // `run` is the CI run that showed it, `date` when. This allows PRACTICE
  // testing only (isPracticeTestableVenue); it never turns on real trading.
  practiceTested?: { run: string; date: string };
}

// Where the copy-exchange fork test passed (CI 'contracts' job, annotation
// "Copy venue fork results"). Same run for all six.
const COPY_FORK_RUN = { run: 'https://github.com/rankine-labs/multichain-arb-engine/actions/runs/37880135355', date: '2026-10-08' };

// Where the Algebra fork test passed (contracts/test/ForkAlgebraVenues.t.sol,
// CI annotation "Algebra venue fork results"): Alandale and KittenSwap
// WETH/USDG pools, both directions, with the executor that has
// algebraSwapCallback. That callback is only in the contract SOURCE (and so
// in the practice simulator's copy); the contract deployed on chain does not
// have it, so a real Algebra trade would also need a redeploy.
const ALGEBRA_FORK_RUN = { run: 'https://github.com/rankine-labs/multichain-arb-engine/actions/runs/37944712215', date: '2026-10-09' };

export const ROBINHOOD_VENUES: readonly RobinhoodVenue[] = [
  // ---- P0: the user's priority list + the deepest unknown factory -----------
  {
    id: 'alandale', name: 'Alandale (Algebra Integral CL)', priority: 'P0', model: 'algebra',
    contracts: [{ role: 'factory', address: '0x16494A80E08Bcb9285D87b67149d7b01774D82F8' }],
    priceable: true, executionEnabled: false,
    executionBlocker: 'Algebra callback: in the contract source and fork-tested (practiceTested, WETH/USDG both ways), but the deployed contract lacks it; real trades need a redeploy and approval.',
    source: ['DefiLlama dimension-adapters dexs/alandale/index.ts', 'rival-trade probe: factory of the deep SPY/USDG and WETH/USDG pools'],
    practiceTested: ALGEBRA_FORK_RUN,
  },
  {
    id: 'giga-cl', name: 'GIGA DEX CL', priority: 'P0', model: 'pancake-v3',
    contracts: [{ role: 'factory', address: '0xEce6eCd61177336ea6Fb9b17937AC439D85EE20B' }],
    priceable: true, executionEnabled: false,
    executionBlocker: 'PancakeSwap V3 callback; our executor traded its WETH/USDG pool both ways on a fork (practiceTested). Not yet approved for real trades.',
    source: ['https://docs.gigadex.fi/security/contracts', 'DefiLlama dimension-adapters dexs/giga-dex/index.ts'],
    practiceTested: COPY_FORK_RUN,
  },
  {
    id: 'giga-classic', name: 'GIGA DEX Classic (Solidly pairs)', priority: 'P0', model: 'solidly',
    contracts: [{ role: 'factory', address: '0x6Fdf38f92eAd1adFc04B73aaa947ab254f6c0916' }],
    priceable: true, executionEnabled: false,
    executionBlocker: 'Fee is set per pair (millionths); our contract sizes Solidly pairs at a fixed fee. Stable pairs use a curve the bot cannot price.',
    source: ['https://docs.gigadex.fi/security/contracts', 'DefiLlama dimension-adapters dexs/giga-dex/index.ts'],
  },
  {
    id: 'giga-brownfi', name: 'GIGA DEX BrownFi (oracle pairs)', priority: 'P2', model: 'oracle-amm',
    contracts: [{ role: 'factory', address: '0x831880Bd3b331249DF63bacC6e21495e5e8f1eAA' }, { role: 'pair-config', address: '0xD3F729D909a7E84669A35c3F25b37b4AC3487784' }],
    priceable: false, executionEnabled: false,
    executionBlocker: 'Price comes from an outside oracle, not pool balances.',
    source: ['DefiLlama dimension-adapters dexs/giga-dex/index.ts'],
  },
  {
    id: 'fables', name: 'Fables (Uniswap V4 hooks, dynamic fee)', priority: 'P0', model: 'v4-hooked',
    contracts: [{ role: 'registry', address: '0x159a113e012593d9b3cc63ad45e30f0467e13ef3' }],
    priceable: true, executionEnabled: false,
    executionBlocker: 'Pools sit on the shared V4 PoolManager but carry a hook that sets the fee per swap; our V4 path assumes a fixed fee and no hook.',
    source: ['DefiLlama dimension-adapters dexs/fables.ts (FablesPoolRegistry.activePools())'],
  },
  {
    id: 'metric', name: 'Metric OMM (oracle market maker)', priority: 'P0', model: 'oracle-amm',
    contracts: [
      { role: 'factory', address: '0x2a53833cc95548cf52c7b159110e22D3a9018f32' },
      { role: 'retired-factory', address: '0x622911384e7973439b8be305f5e3Fc3c5736EDe4' },
      { role: 'factory', address: '0xe22F9fc0f04486dE25ed6CF1800a4a47aFD82e0C' },
    ],
    priceable: false, executionEnabled: false,
    executionBlocker: 'Each pool follows a price provider (oracle), so pool state alone does not give the price; would need a quote call per trade.',
    source: ['DefiLlama dimension-adapters dexs/metric-v1/index.ts and dexs/metric/index.ts'],
  },
  {
    id: 'tessera', name: 'Tessera (proprietary market maker)', priority: 'P0', model: 'prop-amm',
    contracts: [{ role: 'swap', address: '0x55555522005BcAE1c2424D474BfD5ed477749E3e' }],
    priceable: false, executionEnabled: false,
    executionBlocker: "A market maker's contract with its own pricing; no public pool state to price from.",
    source: ['DefiLlama dimension-adapters dexs/tessera/index.ts (TesseraTrade event)'],
  },
  {
    id: 'ekubo', name: 'Ekubo (singleton)', priority: 'P0', model: 'singleton',
    contracts: [{ role: 'core', address: '0x00000000000014aA86C5d3c41765bb24e11bd701' }],
    priceable: false, executionEnabled: false,
    executionBlocker: 'One core contract with its own pool ids, extensions and lock/callback settlement; needs its own adapter.',
    source: ['https://docs.ekubo.org/reference/contracts/evm-v3/', 'PR #75'],
  },
  // ---- P1: other unknown factories seen in rival trades ----------------------
  {
    id: 'up-cl', name: 'UP CL (Slipstream copy)', priority: 'P1', model: 'slipstream',
    contracts: [{ role: 'factory', address: '0x1ac9dB4a2608ba45D6127B1737949b51Bb54B7F3' }],
    priceable: true, executionEnabled: false,
    executionBlocker: 'Slipstream copy (Uniswap V3 callback, tick-spacing pools); our executor traded its WETH/USDG pool both ways on a fork (practiceTested). Not yet approved for real trades.',
    source: ['DefiLlama dimension-adapters dexs/up-v3/index.ts', 'rival-trade probe (WETH/USDG pool)'],
    practiceTested: COPY_FORK_RUN,
  },
  {
    id: 'swaphood-v3', name: 'SwapHood V3', priority: 'P1', model: 'pancake-v3',
    contracts: [{ role: 'factory', address: '0x0Ec554F0BfF0Be6C99d1e95C8015bb0950f6A2C7' }],
    priceable: true, executionEnabled: false,
    executionBlocker: 'PancakeSwap V3 copy; our executor traded its WETH/USDG pool both ways on a fork (practiceTested). Not yet approved for real trades.',
    source: ['DefiLlama dimension-adapters dexs/swaphood-v3/index.ts'],
    practiceTested: COPY_FORK_RUN,
  },
  {
    id: 'topaz-cl', name: 'Topaz CL (Slipstream copy)', priority: 'P1', model: 'slipstream',
    contracts: [{ role: 'factory', address: '0xaa5865dC3A60b25D305226d66fd573021f0D8fFB' }],
    priceable: true, executionEnabled: false,
    executionBlocker: 'Slipstream copy (Uniswap V3 callback, tick-spacing pools); our executor traded its WETH/USDG pool both ways on a fork (practiceTested). Not yet approved for real trades.',
    source: ['DefiLlama dimension-adapters dexs/topaz-cl/index.ts'],
    practiceTested: COPY_FORK_RUN,
  },
  {
    id: 'raphael-cl', name: 'Raphael Slipstream', priority: 'P1', model: 'slipstream',
    contracts: [{ role: 'factory', address: '0x5481864ddd46a2D798Df0925C23B7846e776E5E3' }],
    priceable: true, executionEnabled: false,
    executionBlocker: 'Slipstream copy (Uniswap V3 callback, tick-spacing pools); our executor traded its WETH/USDG pool both ways on a fork (practiceTested). Not yet approved for real trades.',
    source: ['DefiLlama dimension-adapters dexs/raphael-slipstream/index.ts'],
    practiceTested: COPY_FORK_RUN,
  },
  {
    id: 'sushiswap-v3', name: 'SushiSwap V3', priority: 'P1', model: 'uniswap-v3',
    contracts: [{ role: 'factory', address: '0xE51960f1B45f1C9FB6D166E6a884F866fC70433B' }],
    priceable: true, executionEnabled: false,
    executionBlocker: 'Uniswap V3 copy; our executor traded its WETH/USDG pool both ways on a fork (practiceTested). Not yet approved for real trades.',
    source: ['DefiLlama dimension-adapters dexs/sushiswap-v3.ts', 'venue probe run 37845231412 (factory of 7 traded pools)'],
    practiceTested: COPY_FORK_RUN,
  },
  {
    id: 'kittenswap-algebra', name: 'KittenSwap (Algebra)', priority: 'P1', model: 'algebra',
    contracts: [{ role: 'factory', address: '0xf03875b5Ec5eAc83cab83A6c2ab17844304AA7a0' }],
    priceable: true, executionEnabled: false,
    executionBlocker: 'Algebra callback: in the contract source and fork-tested (practiceTested, WETH/USDG both ways), but the deployed contract lacks it; real trades need a redeploy and approval. Plugins can override the fee per swap (SwapFee event).',
    source: ['DefiLlama dimension-adapters dexs/kittenswap-algebra/index.ts', 'venue probe run 37845231412'],
    practiceTested: ALGEBRA_FORK_RUN,
  },
  // ---- P2: documented by the project, not seen in rival trades ---------------
  {
    id: 'goo-exchange', name: 'Goo Exchange', priority: 'P2', model: 'uniswap-v3',
    contracts: [{ role: 'factory', address: '0x221A6239E40709792b0d4bdc140fA36158CD41C7' }],
    priceable: true, executionEnabled: false,
    executionBlocker: 'Unusual fee tiers; not yet validated.',
    source: ['https://goo.exchange/docs/', 'PR #75'],
  },
];

// Venues whose pools the universe scan may read for prices (research only).
export function priceableVenues(): RobinhoodVenue[] {
  return ROBINHOOD_VENUES.filter((v) => v.priceable);
}

// The one gate for trading: nothing in this file may be traded.
export function isExecutableVenue(dex: string): boolean {
  return !ROBINHOOD_VENUES.some((v) => v.id === dex);
}

// PRACTICE testing only (never real money): true only for venues whose
// pools our executor contract code traded on a live-chain fork
// (practiceTested is set). For the Algebra venues that is the contract
// SOURCE (with algebraSwapCallback), which the practice simulator runs; the
// deployed contract would need a redeploy before a real Algebra trade. executionEnabled stays false for every venue and
// isExecutableVenue() still refuses them; the caller decides where to use this.
export function isPracticeTestableVenue(dex: string): boolean {
  return ROBINHOOD_VENUES.some((v) => v.id === dex && !!v.practiceTested);
}

// Venue for a factory address (lowercase match), if any.
export function venueByFactory(factory: string): RobinhoodVenue | undefined {
  const f = factory.toLowerCase();
  return ROBINHOOD_VENUES.find((v) => v.contracts.some((c) => c.address.toLowerCase() === f));
}

// How the pair watcher should look pools up on each priceable venue
// (core/pairWatcher.ts Venue kinds). Venues not listed here are not read.
export function watcherKindOf(v: RobinhoodVenue): 'algebra' | 'v3-fee' | 'v3-spacing' | 'solidly' | 'v4-registry' | null {
  switch (v.model) {
    case 'algebra': return 'algebra';
    case 'pancake-v3': case 'uniswap-v3': return 'v3-fee';
    case 'slipstream': return 'v3-spacing';
    case 'solidly': return 'solidly';
    case 'v4-hooked': return 'v4-registry';
    default: return null;
  }
}

// Extra pair-watcher venues (price reading only). The caller adds them only
// when RH_EXTRA_VENUES=1; the trade path refuses them via isExecutableVenue().
export function extraWatcherVenues(v4: { stateView: string; poolManager: string; weth: string }) {
  const out: { dex: string; kind: 'algebra' | 'v3-fee' | 'v3-spacing' | 'solidly' | 'v4-registry'; factory: string; registry?: string; poolManager?: string; weth?: string; pairFee?: boolean }[] = [];
  for (const v of priceableVenues()) {
    const kind = watcherKindOf(v);
    if (!kind) continue;
    if (kind === 'v4-registry') {
      const reg = v.contracts.find((c) => c.role === 'registry');
      if (reg) out.push({ dex: v.id, kind, factory: v4.stateView, registry: reg.address, poolManager: v4.poolManager, weth: v4.weth });
      continue;
    }
    const f = v.contracts.find((c) => c.role === 'factory');
    if (f) out.push({ dex: v.id, kind, factory: f.address, ...(kind === 'solidly' ? { pairFee: true } : {}) });
  }
  return out;
}

// Extra factories for the chain-wide universe scan (pool creation events).
export function extraScanFactories(): { dex: string; kind: 'v2' | 'solidly' | 'v3'; factory: string }[] {
  return priceableVenues().flatMap((v) => {
    const kind = watcherKindOf(v);
    const f = v.contracts.find((c) => c.role === 'factory');
    if (!kind || kind === 'v4-registry' || !f) return [];
    return [{ dex: v.id, kind: kind === 'solidly' ? 'solidly' as const : 'v3' as const, factory: f.address }];
  });
}
