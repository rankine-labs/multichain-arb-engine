// ============================================================================
// NITRO PRECOMPILES (owner: workstream B)
//
// Plain English:
//   Arbitrum Nitro has built-in "system contracts" at low addresses (0x64
//   ArbSys, 0x6c ArbGasInfo, ...). They are Go code inside the node, not EVM
//   bytecode, so revm doesn't know them. This file imitates the ones our
//   trades (and the tokens / pools they touch) can reach, with Nitro's EXACT
//   gas charges, and refuses everything else loudly:
//
//     - a call to a Nitro precompile or method we don't imitate
//     - a call into a Stylus (WebAssembly) contract
//   stops the run with an error starting "unsupported precompile" and is
//   remembered in `ArbPrecompiles::unsupported()`. The check engine must turn
//   that into "unknown" (never a silent wrong answer).
//
// HOW NITRO CHARGES GAS FOR A PRECOMPILE METHOD (nitro master @ ccc5c828):
//   precompiles/precompile.go Precompile.Call L727-866:
//     1. input < 4 bytes, unknown selector, method not active at this ArbOS
//        version, view/write method reached through DELEGATECALL/CALLCODE,
//        write method in a static call, value sent to a non-payable method
//        -> revert, ALL supplied gas consumed (L743-767)
//     2. makeContext (precompiles/context.go L139-176): any non-pure method
//        opens the ArbOS state = 1 metered storage read of the version slot
//        = 800 gas (arbos/arbosState/arbosstate.go L80-85,
//        arbos/storage/storage.go L61/L139-141). Not enough gas -> out of
//        gas (all gas consumed).
//     3. arguments: 3 gas per 32-byte word after the selector (L776-780)
//     4. the method itself: every further ArbOS storage read 800 gas
//     5. result: 3 gas per 32-byte word of the ABI-encoded result (L859-863);
//        a Solidity custom error pays the same per word and reverts with the
//        remaining gas returned (L819-827).
//   => arbBlockNumber() = 800 + 0 + 0 + 3 = 803 gas (+ the caller's 100 for a
//      warm STATICCALL). Same for every ArbSys view method returning one word.
//   => ArbGasInfo one-value getters = 800 + 800 + 3 = 1603 gas.
//
// WARMNESS: Nitro puts EVERY active precompile address (Ethereum ones and
//   all ArbOS ones) in the access list at tx start (go-ethereum
//   core/vm/contracts.go L252-279 ActivePrecompiles, core/state/statedb.go
//   L1585-1587). So a call to 0x64 costs 100 (warm), never 2600 (cold).
//   `warm_addresses()` lists them all; `contains()` lists only what we run.
// ============================================================================
use std::sync::OnceLock;

use revm::{
    context_interface::{Cfg, ContextError, ContextTr, JournalTr, LocalContextTr},
    handler::{precompile_output_to_interpreter_result, PrecompileProvider},
    interpreter::{CallInputs, CallScheme, InterpreterResult},
    precompile::{secp256r1, PrecompileHalt, PrecompileOutput, Precompiles},
    primitives::{address, Address, AddressSet, Bytes, U256},
    Database,
};

use super::arbos::{self, ARBOS_ACTS_ADDRESS, ARBOS_STATE_ADDRESS, COPY_GAS, STORAGE_READ_COST};
use super::ArbConfig;

// ---------------------------------------------------------------------------
// Addresses (go-ethereum core/types/arbitrum_signer.go L12-30)
// ---------------------------------------------------------------------------
pub const ARBSYS: Address = address!("0000000000000000000000000000000000000064");
pub const ARB_INFO: Address = address!("0000000000000000000000000000000000000065");
pub const ARB_ADDRESS_TABLE: Address = address!("0000000000000000000000000000000000000066");
pub const ARB_BLS: Address = address!("0000000000000000000000000000000000000067");
pub const ARB_FUNCTION_TABLE: Address = address!("0000000000000000000000000000000000000068");
pub const ARBOS_TEST: Address = address!("0000000000000000000000000000000000000069");
pub const ARB_OWNER_PUBLIC: Address = address!("000000000000000000000000000000000000006b");
pub const ARB_GAS_INFO: Address = address!("000000000000000000000000000000000000006c");
pub const ARB_AGGREGATOR: Address = address!("000000000000000000000000000000000000006d");
pub const ARB_RETRYABLE_TX: Address = address!("000000000000000000000000000000000000006e");
pub const ARB_STATISTICS: Address = address!("000000000000000000000000000000000000006f");
pub const ARB_OWNER: Address = address!("0000000000000000000000000000000000000070");
pub const ARB_WASM: Address = address!("0000000000000000000000000000000000000071");
pub const ARB_WASM_CACHE: Address = address!("0000000000000000000000000000000000000072");
pub const ARB_NATIVE_TOKEN_MANAGER: Address = address!("0000000000000000000000000000000000000073");
pub const ARB_FILTERED_TX_MANAGER: Address = address!("0000000000000000000000000000000000000074");
/// NodeInterface: NOT a precompile inside the EVM (only intercepted by the
/// node's RPC for top-level calls); listed so checks treat it as unsure.
pub const NODE_INTERFACE: Address = address!("00000000000000000000000000000000000000c8");
pub const NODE_INTERFACE_DEBUG: Address = address!("00000000000000000000000000000000000000c9");
pub const ARB_DEBUG: Address = address!("00000000000000000000000000000000000000ff");

/// (address, first ArbOS version where it exists) for every ArbOS precompile
/// Nitro registers (precompiles/precompile.go L515-700; gethhook/geth-hook.go
/// L86-121 puts a precompile in the active set once ArbOS >= its version).
const NITRO_PRECOMPILES: &[(Address, u64)] = &[
    (ARBSYS, 0),
    (ARB_INFO, 0),
    (ARB_ADDRESS_TABLE, 0),
    (ARB_BLS, 0),
    (ARB_FUNCTION_TABLE, 0),
    (ARBOS_TEST, 0),
    (ARB_OWNER_PUBLIC, 0),
    (ARB_GAS_INFO, 0),
    (ARB_AGGREGATOR, 0),
    (ARB_RETRYABLE_TX, 0),
    (ARB_STATISTICS, 0),
    (ARB_OWNER, 0),
    (ARB_WASM, 30),
    (ARB_WASM_CACHE, 30),
    (ARB_NATIVE_TOKEN_MANAGER, 41),
    (ARB_FILTERED_TX_MANAGER, 60),
    (ARB_DEBUG, 0),
    (ARBOS_ACTS_ADDRESS, 0),
];

/// ArbOS precompile addresses active at `arbos_version` (all start warm).
pub fn nitro_precompile_addresses(arbos_version: u64) -> Vec<Address> {
    NITRO_PRECOMPILES.iter().filter(|(_, v)| arbos_version >= *v).map(|(a, _)| *a).collect()
}

/// Every Arbitrum built-in address a check should treat as "Nitro code":
/// all ArbOS precompiles (any version) + NodeInterface (0xc8/0xc9).
/// For the check engine's "unsupported built-in" list (minus `contains()`).
pub fn arbitrum_builtin_addresses() -> Vec<Address> {
    let mut v: Vec<Address> = NITRO_PRECOMPILES.iter().map(|(a, _)| *a).collect();
    v.extend([NODE_INTERFACE, NODE_INTERFACE_DEBUG]);
    v
}

// ---------------------------------------------------------------------------
// Gas numbers (derivation in the header comment)
// ---------------------------------------------------------------------------
/// Opening the ArbOS state: one metered read of the version slot.
pub const ARBOS_OPEN_GAS: u64 = STORAGE_READ_COST; // 800
/// Any ArbSys view method with no arguments and a one-word result
/// (arbBlockNumber, arbChainID, arbOSVersion, isTopLevelCall, ...).
pub const ARBSYS_VIEW_GAS: u64 = ARBOS_OPEN_GAS + COPY_GAS; // 803
/// ArbGasInfo getter that reads one ArbOS slot and returns one word.
pub const ARBGASINFO_ONE_READ_GAS: u64 = ARBOS_OPEN_GAS + STORAGE_READ_COST + COPY_GAS; // 1603

/// Error text prefix for "this run touched Nitro code we don't imitate".
/// The check engine should map run errors starting with it to
/// `unsupported_precompile` (or read `ArbPrecompiles::unsupported()`).
pub const UNSUPPORTED_PRECOMPILE_PREFIX: &str = "unsupported precompile";

/// What unsupported thing a run touched.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnsupportedHit {
    pub address: Address,
    /// 4-byte method selector, when known.
    pub selector: Option<[u8; 4]>,
    pub what: &'static str,
}

impl std::fmt::Display for UnsupportedHit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{UNSUPPORTED_PRECOMPILE_PREFIX} {}", self.address)?;
        if let Some(s) = self.selector {
            write!(f, " selector 0x{:02x}{:02x}{:02x}{:02x}", s[0], s[1], s[2], s[3])?;
        }
        write!(f, ": {}", self.what)
    }
}

// ---------------------------------------------------------------------------
// Method tables
// ---------------------------------------------------------------------------
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Purity {
    Pure,
    View,
    Write,
    Payable,
}

/// How we answer a method.
#[derive(Clone, Copy, Debug)]
enum Impl {
    /// We don't imitate it -> unsupported.
    No,
    ArbBlockNumber,
    ArbChainId,
    ArbOsVersion,
    Zero,           // getStorageGasAvailable
    IsTopLevelCall, // depth <= 2
    False,          // wasMyCallersAddressAliased (never true for eth_call / signed txs)
    MapL1Alias,
    ArbBlockHash,
    /// One ArbOS slot: (subspace, offset, signed int64 encoding?)
    Slot(u8, u64, bool),
    GasAccountingParams,
}

#[derive(Clone, Copy, Debug)]
struct Method {
    selector: [u8; 4],
    purity: Purity,
    /// ABI argument words (all our methods take static 32-byte args).
    args: usize,
    min_arbos: u64,
    imp: Impl,
}

const fn m(selector: [u8; 4], purity: Purity, args: usize, min_arbos: u64, imp: Impl) -> Method {
    Method { selector, purity, args, min_arbos, imp }
}

// ArbSys (precompiles/ArbSys.go; selectors = keccak of the Solidity signature,
// interfaces in OffchainLabs/nitro-precompile-interfaces ArbSys.sol).
const ARBSYS_METHODS: &[Method] = &[
    m([0xa3, 0xb1, 0xb3, 0x1d], Purity::View, 0, 0, Impl::ArbBlockNumber), // arbBlockNumber()
    m([0x2b, 0x40, 0x7a, 0x82], Purity::View, 1, 0, Impl::ArbBlockHash),   // arbBlockHash(uint256)
    m([0xd1, 0x27, 0xf5, 0x4a], Purity::View, 0, 0, Impl::ArbChainId),     // arbChainID()
    m([0x05, 0x10, 0x38, 0xf2], Purity::View, 0, 0, Impl::ArbOsVersion),   // arbOSVersion()
    m([0xa9, 0x45, 0x97, 0xff], Purity::View, 0, 0, Impl::Zero),           // getStorageGasAvailable()
    m([0x08, 0xbd, 0x62, 0x4c], Purity::View, 0, 0, Impl::IsTopLevelCall), // isTopLevelCall()
    m([0x4d, 0xbb, 0xd5, 0x06], Purity::Pure, 2, 0, Impl::MapL1Alias),     // mapL1SenderContractAddressToL2Alias(address,address)
    m([0x17, 0x5a, 0x26, 0x0b], Purity::View, 0, 0, Impl::False),          // wasMyCallersAddressAliased()
    m([0xd7, 0x45, 0x23, 0xb3], Purity::View, 0, 0, Impl::No),             // myCallersAddressWithoutAliasing() (needs Nitro's call stack)
    m([0x92, 0x8c, 0x16, 0x9a], Purity::Payable, 2, 0, Impl::No),          // sendTxToL1(address,bytes)
    m([0x25, 0xe1, 0x60, 0x63], Purity::Payable, 1, 0, Impl::No),          // withdrawEth(address)
    m([0x7a, 0xee, 0xcd, 0x2a], Purity::View, 0, 0, Impl::No),             // sendMerkleTreeState()
];

// ArbGasInfo (precompiles/ArbGasInfo.go L161-295; method versions from
// precompiles/precompile.go L528-541). Only the one-slot getters are
// imitated; the rest (prices with aggregator, surplus, constraints, the
// current tx's L1 fee) report unsupported.
use super::arbos::{l1, l2, L1_PRICING_SUBSPACE as L1S, L2_PRICING_SUBSPACE as L2S};
const ARBGASINFO_METHODS: &[Method] = &[
    m([0xf9, 0x18, 0x37, 0x9a], Purity::View, 0, 0, Impl::Slot(L2S, l2::MIN_BASE_FEE_WEI, false)), // getMinimumGasPrice
    m([0xf5, 0xd6, 0xde, 0xd7], Purity::View, 0, 0, Impl::Slot(L1S, l1::PRICE_PER_UNIT, false)),   // getL1BaseFeeEstimate
    m([0x05, 0x5f, 0x36, 0x2f], Purity::View, 0, 0, Impl::Slot(L1S, l1::PRICE_PER_UNIT, false)),   // getL1GasPriceEstimate
    m([0x29, 0xeb, 0x31, 0xee], Purity::View, 0, 0, Impl::Slot(L1S, l1::INERTIA, false)),          // getL1BaseFeeEstimateInertia
    m([0x8a, 0x5b, 0x1d, 0x28], Purity::View, 0, 11, Impl::Slot(L1S, l1::PER_UNIT_REWARD, false)), // getL1RewardRate
    m([0x9e, 0x6d, 0x7e, 0x31], Purity::View, 0, 11, Impl::Slot(L1S, l1::PAY_REWARDS_TO, false)),  // getL1RewardRecipient
    m([0x1d, 0x5b, 0x5c, 0x20], Purity::View, 0, 0, Impl::Slot(L2S, l2::GAS_BACKLOG, false)),      // getGasBacklog
    m([0x3d, 0xfb, 0x45, 0xb9], Purity::View, 0, 0, Impl::Slot(L2S, l2::PRICING_INERTIA, false)),  // getPricingInertia
    m([0x25, 0x75, 0x4f, 0x91], Purity::View, 0, 0, Impl::Slot(L2S, l2::BACKLOG_TOLERANCE, false)), // getGasBacklogTolerance
    m([0x6e, 0xcc, 0xa4, 0x5a], Purity::View, 0, 0, Impl::Slot(L1S, l1::PER_BATCH_GAS_COST, true)), // getPerBatchGasCharge (int64)
    m([0x7a, 0x7d, 0x6b, 0xeb], Purity::View, 0, 0, Impl::Slot(L1S, l1::AMORTIZED_COST_CAP_BIPS, false)), // getAmortizedCostCapBips
    m([0x5b, 0x39, 0xd2, 0x3c], Purity::View, 0, 10, Impl::Slot(L1S, l1::L1_FEES_AVAILABLE, false)), // getL1FeesAvailable
    m([0xad, 0x26, 0xce, 0x90], Purity::View, 0, 20, Impl::Slot(L1S, l1::EQUILIBRATION_UNITS, false)), // getL1PricingEquilibrationUnits
    m([0x13, 0x8b, 0x47, 0xb4], Purity::View, 0, 20, Impl::Slot(L1S, l1::LAST_UPDATE_TIME, false)), // getLastL1PricingUpdateTime
    m([0x96, 0x3d, 0x60, 0x02], Purity::View, 0, 20, Impl::Slot(L1S, l1::FUNDS_DUE_FOR_REWARDS, false)), // getL1PricingFundsDueForRewards (int256 as stored)
    m([0xef, 0xf0, 0x13, 0x06], Purity::View, 0, 20, Impl::Slot(L1S, l1::UNITS_SINCE, false)),     // getL1PricingUnitsSinceUpdate
    m([0x29, 0x87, 0xd0, 0x27], Purity::View, 0, 20, Impl::Slot(L1S, l1::LAST_SURPLUS, false)),    // getLastL1PricingSurplus (int256 as stored)
    m([0xaa, 0xe1, 0xcd, 0x4c], Purity::View, 0, 50, Impl::Slot(L2S, l2::PER_TX_GAS_LIMIT, false)), // getMaxTxGasLimit
    m([0x03, 0x71, 0xfd, 0xb4], Purity::View, 0, 50, Impl::Slot(L2S, l2::PER_BLOCK_GAS_LIMIT, false)), // getMaxBlockGasLimit
    m([0x61, 0x2a, 0xf1, 0x78], Purity::View, 0, 0, Impl::GasAccountingParams), // getGasAccountingParams
    m([0xba, 0x9c, 0x91, 0x6e], Purity::View, 1, 0, Impl::No), // getPricesInWeiWithAggregator(address)
    m([0x41, 0xb2, 0x47, 0xa8], Purity::View, 0, 0, Impl::No), // getPricesInWei()
    m([0x7a, 0x1e, 0xa7, 0x32], Purity::View, 1, 0, Impl::No), // getPricesInArbGasWithAggregator(address)
    m([0x02, 0x19, 0x9f, 0x34], Purity::View, 0, 0, Impl::No), // getPricesInArbGas()
    m([0xc6, 0xf7, 0xde, 0x0e], Purity::View, 0, 0, Impl::No), // getCurrentTxL1GasFees()
    m([0x52, 0x0a, 0xcd, 0xd7], Purity::View, 0, 0, Impl::No), // getL1PricingSurplus()
    m([0x23, 0x20, 0x27, 0xd1], Purity::View, 0, 50, Impl::No), // getGasPricingConstraints()
    m([0xbb, 0xfc, 0x0a, 0x72], Purity::View, 0, 60, Impl::No), // getMultiGasPricingConstraints()
    m([0xc0, 0xe1, 0x0b, 0xbb], Purity::View, 0, 60, Impl::No), // getMultiGasBaseFee()
];

/// Custom error InvalidBlockNumber(uint256 requested, uint256 current).
const INVALID_BLOCK_NUMBER_SELECTOR: [u8; 4] = [0xd5, 0xdc, 0x64, 0x2d];

/// Address alias offset (arbos/util/util.go L36): L2 alias = L1 + offset (mod 2^160).
const ALIAS_OFFSET: U256 = U256::from_limbs([0x0000_0000_0000_1111, 0x0000_0000_0000_0000, 0x1111_0000, 0]);

fn words(len: usize) -> u64 {
    len.div_ceil(32) as u64
}

/// Stylus (WebAssembly) program prefixes (go-ethereum core/state/statedb_arbitrum.go
/// L49-91): EF F0 00 classic program; EF F0 02 root program (ArbOS >= 60).
pub fn is_stylus_code(code: &[u8], arbos_version: u64) -> bool {
    if arbos_version < 30 || code.len() <= 3 || code[0] != 0xEF || code[1] != 0xF0 {
        return false;
    }
    code[2] == 0x00 || (arbos_version >= 60 && code[2] == 0x02)
}

// ---------------------------------------------------------------------------
// Ethereum precompile set as Nitro has it (gethhook/geth-hook.go L108-114)
//   ArbOS < 30 : Berlin set
//   ArbOS 30-49: Cancun set + P256VERIFY at 0x100 (3,450 gas)  [no BLS!]
//   ArbOS >= 50: Osaka set (BLS 0x0b-0x11, P256VERIFY 6,900 gas, new modexp)
// ---------------------------------------------------------------------------
fn eth_precompiles_for(arbos_version: u64) -> &'static Precompiles {
    static CANCUN_P256: OnceLock<Precompiles> = OnceLock::new();
    if arbos_version >= 50 {
        Precompiles::osaka()
    } else if arbos_version >= 30 {
        CANCUN_P256.get_or_init(|| {
            let mut p = Precompiles::cancun().clone();
            p.extend([secp256r1::P256VERIFY]);
            p
        })
    } else {
        Precompiles::berlin()
    }
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------
/// Our precompile set = Nitro's Ethereum precompiles + imitated ArbOS ones.
#[derive(Clone)]
pub struct ArbPrecompiles {
    eth: &'static Precompiles,
    cfg: ArbConfig,
    /// What arbBlockNumber() returns. None = plain-EVM mode (no ArbOS
    /// precompiles at all; 0x64 is an empty account, like a local test chain).
    l2_block: Option<U256>,
    /// Gas charged for arbBlockNumber() (default 803 = exact Nitro charge).
    arbsys_gas: u64,
    warm: AddressSet,
    /// Addresses we actually execute (eth set + ArbSys + ArbGasInfo).
    implemented: AddressSet,
    /// Active ArbOS precompile addresses (all of them, imitated or not).
    nitro: AddressSet,
    initialized: bool,
    unsupported: Option<UnsupportedHit>,
}

impl ArbPrecompiles {
    /// Same signature as before: default config (ArbConfig::default()).
    pub fn new(l2_block: Option<U256>, arbsys_gas: u64) -> Self {
        Self::with_config(l2_block, arbsys_gas, &ArbConfig::default())
    }

    /// With an explicit chain config (ArbOS version decides the precompile set).
    pub fn with_config(l2_block: Option<U256>, arbsys_gas: u64, cfg: &ArbConfig) -> Self {
        let eth = eth_precompiles_for(cfg.arbos_version);
        let mut warm = eth.addresses_set().clone();
        let mut implemented = eth.addresses_set().clone();
        let mut nitro = AddressSet::default();
        if l2_block.is_some() {
            for a in nitro_precompile_addresses(cfg.arbos_version) {
                warm.insert(a);
                nitro.insert(a);
            }
            implemented.insert(ARBSYS);
            implemented.insert(ARB_GAS_INFO);
        }
        Self { eth, cfg: cfg.clone(), l2_block, arbsys_gas, warm, implemented, nitro, initialized: false, unsupported: None }
    }

    /// First unsupported thing the runs so far touched (None = all fine).
    pub fn unsupported(&self) -> Option<&UnsupportedHit> {
        self.unsupported.as_ref()
    }
    /// Read and clear (call between independent checks).
    pub fn take_unsupported(&mut self) -> Option<UnsupportedHit> {
        self.unsupported.take()
    }
    /// The config this set was built for.
    pub fn config(&self) -> &ArbConfig {
        &self.cfg
    }
    /// true = we run this address ourselves (not "unsupported").
    pub fn implements(&self, a: &Address) -> bool {
        self.implemented.contains(a)
    }

    fn fail(&mut self, address: Address, selector: Option<[u8; 4]>, what: &'static str) -> String {
        let hit = UnsupportedHit { address, selector, what };
        let msg = hit.to_string();
        if self.unsupported.is_none() {
            self.unsupported = Some(hit);
        }
        msg
    }

    /// One call into ArbSys / ArbGasInfo (exact Nitro gas, see header).
    fn run_nitro<CTX: ContextTr>(&mut self, context: &mut CTX, inputs: &CallInputs) -> Result<PrecompileOutput, String> {
        let addr = inputs.bytecode_address;
        let gl = inputs.gas_limit;
        let res = inputs.reservoir;
        let input: Vec<u8> = inputs.input.as_bytes(context).to_vec();
        let revert_all = || PrecompileOutput::revert(gl, Bytes::new(), res);

        let table = match addr {
            ARBSYS => ARBSYS_METHODS,
            ARB_GAS_INFO => ARBGASINFO_METHODS,
            _ => return Err(self.fail(addr, input.get(..4).map(|s| s.try_into().unwrap()), "ArbOS precompile not imitated")),
        };
        // 1. checks that revert with ALL gas consumed
        if input.len() < 4 {
            return Ok(revert_all());
        }
        let sel: [u8; 4] = input[..4].try_into().unwrap();
        let Some(meth) = table.iter().find(|x| x.selector == sel).copied() else {
            return Ok(revert_all()); // no such method
        };
        if self.cfg.arbos_version < meth.min_arbos {
            return Ok(revert_all()); // not active yet
        }
        let acting_as_self = !matches!(inputs.scheme, CallScheme::DelegateCall | CallScheme::CallCode);
        if meth.purity >= Purity::View && !acting_as_self {
            return Ok(revert_all());
        }
        if meth.purity >= Purity::Write && inputs.is_static {
            return Ok(revert_all());
        }
        if meth.purity < Purity::Payable && !inputs.value.get().is_zero() {
            return Ok(revert_all());
        }
        // 2. open ArbOS state (non-pure): out of gas = halt, all gas
        let mut used: u64 = 0;
        if meth.purity != Purity::Pure {
            if gl < ARBOS_OPEN_GAS {
                return Ok(PrecompileOutput::halt(PrecompileHalt::OutOfGas, res));
            }
            used += ARBOS_OPEN_GAS;
        }
        // 3. argument copy cost
        let args_cost = COPY_GAS * words(input.len() - 4);
        if gl - used < args_cost {
            return Ok(revert_all());
        }
        used += args_cost;
        // ABI decode: too little data = revert, all gas
        if input.len() - 4 < 32 * meth.args {
            return Ok(revert_all());
        }
        let arg = |i: usize| U256::from_be_slice(&input[4 + 32 * i..4 + 32 * (i + 1)]);

        // 4. the method itself
        let out: Result<Vec<u8>, Vec<u8>> = match meth.imp {
            Impl::No => return Err(self.fail(addr, Some(sel), "method not imitated")),
            Impl::ArbBlockNumber => {
                // Caller may override the charge (ARBSYS_GAS); default = 803 = exact.
                let n = self.l2_block.unwrap_or_default();
                let g = self.arbsys_gas;
                return Ok(if gl < g {
                    PrecompileOutput::halt(PrecompileHalt::OutOfGas, res)
                } else {
                    PrecompileOutput::new(g, Bytes::copy_from_slice(&n.to_be_bytes::<32>()), res)
                });
            }
            Impl::ArbChainId => Ok(U256::from(self.cfg.chain_id).to_be_bytes::<32>().to_vec()),
            Impl::ArbOsVersion => Ok(U256::from(55 + self.cfg.arbos_version).to_be_bytes::<32>().to_vec()), // ArbSys.go L67-70
            Impl::Zero | Impl::False => Ok(vec![0u8; 32]),
            Impl::IsTopLevelCall => {
                // ArbSys.go L78-80: evm.Depth() <= 2. Nitro's depth inside the
                // precompile = revm journal depth at this point (both count the
                // precompile's own frame).
                let top = context.journal().depth() <= 2;
                Ok(U256::from(top as u8).to_be_bytes::<32>().to_vec())
            }
            Impl::MapL1Alias => {
                let mask: U256 = (U256::from(1u8) << 160) - U256::from(1u8);
                let a: U256 = arg(0) & mask;
                let aliased: U256 = a.wrapping_add(ALIAS_OFFSET) & mask;
                Ok(aliased.to_be_bytes::<32>().to_vec())
            }
            Impl::ArbBlockHash => {
                // ArbSys.go L41-59: only recent L2 blocks; otherwise custom error.
                let req = arg(0);
                let cur = self.l2_block.unwrap_or_default();
                let cur64: u64 = cur.saturating_to();
                let bad = req >= cur || req.saturating_add(U256::from(256u64)) < cur || req > U256::from(u64::MAX) || cur64 == 0;
                if bad {
                    let mut d = INVALID_BLOCK_NUMBER_SELECTOR.to_vec();
                    d.extend_from_slice(&req.to_be_bytes::<32>());
                    d.extend_from_slice(&cur.to_be_bytes::<32>());
                    Err(d)
                } else {
                    return Err(self.fail(addr, Some(sel), "arbBlockHash of a recent L2 block (L2 hashes not kept)"));
                }
            }
            Impl::Slot(sub, off, int64) => {
                if gl - used < STORAGE_READ_COST {
                    return Ok(revert_all()); // BurnOut -> revert, 0 gas left (precompile.go L841-842)
                }
                used += STORAGE_READ_COST;
                let mut w = match read_arbos(context, arbos::arbos_slot(&[sub], off)) {
                    Some(v) => v,
                    None => return Ok(revert_all()), // DB error already stored in context
                };
                if int64 {
                    // StorageBackedInt64 keeps the int64 bits in the low 8 bytes;
                    // ABI int64 is sign-extended to 32 bytes.
                    let low = w.as_limbs()[0];
                    w = if (low as i64) < 0 { U256::MAX - U256::from(!low) } else { U256::from(low) };
                }
                Ok(w.to_be_bytes::<32>().to_vec())
            }
            Impl::GasAccountingParams => {
                // ArbGasInfo.go L161-166: speed limit + per-block limit (2 reads),
                // returns (speed, perBlock, perBlock).
                if gl - used < 2 * STORAGE_READ_COST {
                    return Ok(revert_all());
                }
                used += 2 * STORAGE_READ_COST;
                let s = read_arbos(context, arbos::arbos_slot(&[L2S], l2::SPEED_LIMIT_PER_SECOND));
                let b = read_arbos(context, arbos::arbos_slot(&[L2S], l2::PER_BLOCK_GAS_LIMIT));
                let (Some(s), Some(b)) = (s, b) else { return Ok(revert_all()) };
                let mut v = s.to_be_bytes::<32>().to_vec();
                v.extend_from_slice(&b.to_be_bytes::<32>());
                v.extend_from_slice(&b.to_be_bytes::<32>());
                Ok(v)
            }
        };
        // 5. result copy cost
        let (data, ok) = match out {
            Ok(d) => (d, true),
            Err(d) => (d, false),
        };
        let rc = COPY_GAS * words(data.len());
        if gl - used < rc {
            return Ok(revert_all());
        }
        used += rc;
        Ok(if ok {
            PrecompileOutput::new(used, data.into(), res)
        } else {
            PrecompileOutput::revert(used, data.into(), res)
        })
    }
}

/// Read one ArbOS state slot. Nitro reads ArbOS storage through StateDB
/// directly (no access-list / warm-cold effect; the 800 gas is the only
/// charge), so we read the database directly too: a slot our copy lacks
/// becomes a normal MISS (check/ CheckDb), never a guessed zero.
/// None = database error (stored in context; the run aborts).
fn read_arbos<CTX: ContextTr>(context: &mut CTX, slot: U256) -> Option<U256> {
    match context.journal_mut().db_mut().storage(ARBOS_STATE_ADDRESS, slot) {
        Ok(v) => Some(v),
        Err(e) => {
            *context.error() = Err(ContextError::Db(e));
            None
        }
    }
}

impl<CTX: ContextTr> PrecompileProvider<CTX> for ArbPrecompiles {
    type Output = InterpreterResult;

    fn set_spec(&mut self, _spec: <CTX::Cfg as Cfg>::Spec) -> bool {
        // Our set depends on the ArbOS version (fixed per instance), not on
        // revm's spec: report "changed" once so revm warms our addresses.
        let first = !self.initialized;
        self.initialized = true;
        first
    }

    fn run(&mut self, context: &mut CTX, inputs: &CallInputs) -> Result<Option<InterpreterResult>, String> {
        let addr = inputs.bytecode_address;
        if self.l2_block.is_some() {
            if self.nitro.contains(&addr) {
                let out = self.run_nitro(context, inputs)?;
                return Ok(Some(precompile_output_to_interpreter_result(out, inputs.gas_limit)));
            }
        }
        // Normal Ethereum precompiles (same as revm's EthPrecompiles::run).
        if let Some(p) = self.eth.get(&addr) {
            let output = p.execute(&inputs.input.as_bytes(context), inputs.gas_limit, inputs.reservoir).map_err(|e| e.to_string())?;
            if let Some(h) = output.halt_reason() {
                if !h.is_oog() && context.journal().depth() == 1 {
                    context.local_mut().set_precompile_error_context(h.to_string());
                }
            }
            return Ok(Some(precompile_output_to_interpreter_result(output, inputs.gas_limit)));
        }
        // Stylus (WASM) contract: Nitro runs WebAssembly, revm would run the
        // bytes as EVM code -> refuse (Arbitrum mode only).
        if self.l2_block.is_some() && is_stylus_code(inputs.known_bytecode.1.original_byte_slice(), self.cfg.arbos_version) {
            return Err(self.fail(addr, None, "Stylus (WASM) program"));
        }
        Ok(None)
    }

    fn warm_addresses(&self) -> &AddressSet {
        &self.warm
    }

    /// Only what we really execute. The check engine uses this to decide
    /// which Arbitrum built-ins are "unsupported".
    fn contains(&self, address: &Address) -> bool {
        self.implemented.contains(address)
    }
}
