// ============================================================================
// ROBINHOOD ADDITIONAL VENUES — READ-ONLY DISCOVERY REGISTRY
//
// These entries are NOT enabled in the live swap decoder, pool scanner or
// execution router. Factory/pool bytecode, actual swap math, depth and
// historical output must be validated before moving an entry to production.
// Use separate protocol adapters for singleton/CL/Stable/Algebra variants.
// ============================================================================

export type VenueModel =
  | 'uniswap-v3-like'
  | 'factory-unknown-math'
  | 'singleton-custom'
  | 'concentrated-liquidity-custom'
  | 'stable-or-volatile'
  | 'unknown';

export interface ResearchVenue {
  name: string;
  priority: 'P0' | 'P1' | 'P2';
  model: VenueModel;
  /** Canonical factory/manager from protocol documentation; not a router. */
  address?: string;
  /** Optional pool address documented by the project. */
  examplePool?: string;
  source: string;
  /** Discovery is never equivalent to executable support. */
  executionEnabled: false;
  notes: string;
}

export const ROBINHOOD_RESEARCH_VENUES: readonly ResearchVenue[] = [
  {
    name: 'ekubo-v3', priority: 'P0', model: 'singleton-custom',
    address: '0x00000000000014aA86C5d3c41765bb24e11bd701',
    source: 'https://docs.ekubo.org/reference/contracts/evm-v3/',
    executionEnabled: false,
    notes: 'Core singleton; pool IDs/configuration, extensions, dynamic fees and callback settlement. Never treat as Uniswap V3 factory.',
  },
  {
    name: 'goo-exchange', priority: 'P1', model: 'uniswap-v3-like',
    address: '0x221A6239E40709792b0d4bdc140fA36158CD41C7',
    examplePool: '0x841f00216A273641eD583916e668e24b4A89d1e7',
    source: 'https://goo.exchange/docs/',
    executionEnabled: false,
    notes: 'Published factory and GOO/WETH pool; unusual fee tiers. Verify bytecode and tick behavior before quoting.',
  },
  {
    name: 'reisa', priority: 'P1', model: 'factory-unknown-math',
    address: '0x82Fe4E8b87FfEdE76bC04d74218f588221Ba4e91',
    examplePool: '0xC51442F1c6272704d8F0b5FA979747D442d3DA97',
    source: 'https://reisa.fi/docs/developers',
    executionEnabled: false,
    notes: 'Published factory and REISA/WETH pool; invariant and factory interface not verified.',
  },
  ...[
    ['fables', 'P0', 'unknown'],
    ['tessera-v', 'P0', 'unknown'],
    ['metric-v1', 'P0', 'factory-unknown-math'],
    ['metric-v2', 'P0', 'factory-unknown-math'],
    ['giga-cl', 'P0', 'concentrated-liquidity-custom'],
    ['giga-classic', 'P0', 'stable-or-volatile'],
    ['alandale-v2', 'P1', 'stable-or-volatile'],
    ['alandale-cl', 'P1', 'concentrated-liquidity-custom'],
    ['brownfi-v3', 'P1', 'uniswap-v3-like'],
    ['parity-v3', 'P1', 'uniswap-v3-like'],
    ['robinswap-v3', 'P1', 'uniswap-v3-like'],
    ['swaphood-v2', 'P1', 'factory-unknown-math'],
    ['swaphood-v3', 'P1', 'uniswap-v3-like'],
    ['sushiswap-v3', 'P1', 'uniswap-v3-like'],
    ['swaap-v2', 'P1', 'factory-unknown-math'],
    ['arcus', 'P2', 'unknown'],
    ['elfomofi', 'P2', 'unknown'],
    ['rialto', 'P2', 'unknown'],
    ['orvex', 'P2', 'unknown'],
    ['kittenswap', 'P2', 'unknown'],
  ] as const).map(([name, priority, model]) => ({
    name,
    priority,
    model,
    source: 'https://defillama.com/dexs/chain/robinhood-chain',
    executionEnabled: false as const,
    notes: 'Research candidate only. Canonical deployment and executable spot pool math not yet verified.',
  })),
];

/** Return only entries that have a documented manager/factory address. */
export function researchContracts(): ResearchVenue[] {
  return ROBINHOOD_RESEARCH_VENUES.filter(v => !!v.address);
}

/** Explicit guard to prevent accidental promotion to live execution. */
export function isExecutableResearchVenue(_name: string): false {
  return false;
}
