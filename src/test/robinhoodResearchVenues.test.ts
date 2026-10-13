// ============================================================================
// RESEARCH VENUE REGISTRY REGRESSION TESTS
// No RPC, no transactions, no execution route modification.
// ============================================================================

import { ROBINHOOD_RESEARCH_VENUES, researchContracts, isExecutableResearchVenue } from '../config/robinhoodResearchVenues';

function assert(ok: boolean, message: string): void {
  if (!ok) {
    console.error('FAIL: ' + message);
    process.exitCode = 1;
  } else {
    console.log('PASS: ' + message);
  }
}

const names = ROBINHOOD_RESEARCH_VENUES.map(v => v.name);
assert(new Set(names).size === names.length, 'research venue names are unique');
assert(['ekubo-v3', 'fables', 'metric-v1', 'metric-v2', 'giga-cl', 'giga-classic', 'tessera-v'].every(x => names.includes(x)),
  'priority venues represented');
assert(ROBINHOOD_RESEARCH_VENUES.every(v => v.executionEnabled === false),
  'every research venue explicitly disables execution');
assert(researchContracts().every(v => !!v.address),
  'contract discovery never emits an empty address');
assert(researchContracts().length === 3,
  'only three documented research contracts exposed; no fabricated addresses');
assert(!isExecutableResearchVenue('ekubo-v3'),
  'Ekubo singleton is never automatically promoted to execution');
console.log('Research registry checks complete; no live integration was changed.');
