// ============================================================================
// RECORDED REAL STATE for the stock-pool tick maths tests (Nov 2, 2026).
//
// Read on the server (read-only) from Robinhood Chain at block 104474563:
// each pool's price, liquidity, tick, fees and the range edges near the
// price, plus what the chain's own quoter (V4Quoter / V3 QuoterV2) said a
// trade of ~$200 and ~$1,100 gives back at that same block. "revert" = the
// quoter refused: the pool doesn't have enough liquidity for that trade.
//
// win: the range edges read (lo..hi = the tick span that was read).
// Some windows were trimmed to +-800 ticks around the price to keep this
// file small; the trades below stay inside them unless marked revert.
// ============================================================================

export interface RecordedCase { zeroForOne: boolean; amountIn: string; quoter: string }
export interface RecordedPool {
  k: string; label: string; dex: string; decA: number; decB: number;
  sqrtP: string; L: string; tick: number; lpFee: number; protocolFee: number; ts: number;
  win: { lo: number; hi: number; ticks: [number, string][] };
  cases: RecordedCase[];
}

export const RECORDED_BLOCK = 104474563;

export const RECORDED: RecordedPool[] = [
  {
    // USDG/SNDK V4 (fee 0.40%, spacing 40): ONE position [200640, 204120],
    // price at 204119, one tick under its top edge. Selling SNDK into it
    // pushes the price up, straight out of the position: nothing to buy with.
    k: '0x6d65849d', label: 'USDG/SNDK', dex: 'uniswap-v4', decA: 6, decB: 18,
    sqrtP: '2143223373544949811615455742804299', L: '1487559002642616', tick: 204119, lpFee: 4000, protocolFee: 2867900, ts: 40,
    win: { lo: 203319, hi: 204919, ticks: [[204120, '-1487559002642616']] },
    cases: [
      { zeroForOne: true, amountIn: '200000000', quoter: '145141399971746613' },
      { zeroForOne: false, amountIn: '146354373000000000', quoter: 'revert' },
      { zeroForOne: true, amountIn: '1100000000', quoter: '785527899553004784' },
      { zeroForOne: false, amountIn: '804949049000000000', quoter: 'revert' },
    ],
  },
  {
    // GOOGL/USDG V4 (fee 0.3499%, spacing 60): ONE position [-219300, -217260],
    // price exactly at its bottom edge. Selling GOOGL (price down) gets nothing.
    k: '0xfa29c8b2', label: 'GOOGL/USDG', dex: 'uniswap-v4', decA: 18, decB: 6,
    sqrtP: '1371130136397470918838154', L: '7221430663922951', tick: -219300, lpFee: 3499, protocolFee: 2454103, ts: 60,
    win: { lo: -220100, hi: -218500, ticks: [[-219300, '7221430663922951']] },
    cases: [
      { zeroForOne: true, amountIn: '667777544000000000', quoter: 'revert' },
      { zeroForOne: false, amountIn: '200000000', quoter: '663984090218502484' },
      { zeroForOne: true, amountIn: '3672776490000000000', quoter: 'revert' },
      { zeroForOne: false, amountIn: '1100000000', quoter: '3625948729807004759' },
    ],
  },
  {
    // USDG/HIMS V4 (fee 0.83%, spacing 83): ONE position, price 1 tick under its top.
    // The practice checks' "ZeroAmount(): pool gave back nothing" comes from here.
    k: '0x357c92ce', label: 'USDG/HIMS', dex: 'uniswap-v4', decA: 6, decB: 18,
    sqrtP: '15052792737639449143705914345268749', L: '1909233459558988', tick: 243106, lpFee: 8300, protocolFee: 4097000, ts: 83,
    win: { lo: 242306, hi: 243906, ticks: [[243107, '-1909233459558988']] },
    cases: [
      { zeroForOne: true, amountIn: '200000000', quoter: '7014080488904688613' },
      { zeroForOne: false, amountIn: '7219464611000000000', quoter: 'revert' },
      { zeroForOne: true, amountIn: '1100000000', quoter: 'revert' },
      { zeroForOne: false, amountIn: '39707055362000000000', quoter: 'revert' },
    ],
  },
  {
    // USDG/SNDK V4 (fee 1%, spacing 200): a normal, deeper pool (control case).
    k: '0x2707cb88', label: 'USDG/SNDK', dex: 'uniswap-v4', decA: 6, decB: 18,
    sqrtP: '2393577877975031217768816665085072', L: '22688151122285010', tick: 206329, lpFee: 10000, protocolFee: 4097000, ts: 200,
    win: { lo: 205529, hi: 207129, ticks: [[205600, '-635128964288885'], [206000, '-58842351440303'], [206200, '-3723599725113450'], [206400, '-810157444885681'], [206600, '-9756463800538776'], [206800, '-648258109607310'], [207000, '-61058717601390']] },
    cases: [
      { zeroForOne: true, amountIn: '200000000', quoter: '180489633001476322' },
      { zeroForOne: false, amountIn: '182543323000000000', quoter: '197749914' },
      { zeroForOne: true, amountIn: '1100000000', quoter: '991518088464827990' },
      { zeroForOne: false, amountIn: '1003988278000000000', quoter: '1086337281' },
    ],
  },
  {
    // GOOGL/USDG V3 (Uniswap V3, fee 0.30%, spacing 60): many ranges, mostly
    // thin below the price. Selling ~$1,100 of GOOGL really gives $112.
    k: '0x553e9a45', label: 'GOOGL/USDG', dex: 'uniswap-v3', decA: 18, decB: 6,
    sqrtP: '1332560688034783073157885', L: '2737038851075216', tick: -219871, lpFee: 3000, protocolFee: 0, ts: 60,
    win: { lo: -291840, hi: -153660, ticks: [[-221100, '347414181065'], [-220260, '1916434719287'], [-219900, '2732039262495074'], [-219840, '149584658729478'], [-219480, '-2301441119326578'], [-219420, '-188170819504392'], [-219240, '-147123220652753'], [-218940, '-242427323664104'], [-218820, '206094606809359'], [-218760, '2162503399267673'], [-218700, '37843252015314'], [-218460, '-206094606809359'], [-218040, '-80981019394179'], [-217920, '16234269457777'], [-217260, '-55993956192378'], [-217200, '-2081522379873494'], [-217020, '-347414181065'], [-214980, '-2461438076725']] },
    cases: [
      { zeroForOne: true, amountIn: '706993090000000000', quoter: '102318732' },
      { zeroForOne: false, amountIn: '200000000', quoter: '701897400596750007' },
      { zeroForOne: true, amountIn: '3888461996000000000', quoter: '112308684' },
      { zeroForOne: false, amountIn: '1100000000', quoter: '3782472897232304185' },
    ],
  },
];
