// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Plain test token: anyone can mint. Used only on the local practice chain.
contract TestToken {
    string public name;
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    constructor(string memory n, uint8 d) { name = n; decimals = d; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

interface IV3PoolMint {
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external returns (uint256, uint256);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

// Adds liquidity to a real Uniswap V3 pool (the pool calls us back to collect the tokens).
contract V3Minter {
    function mint(address pool, int24 lo, int24 hi, uint128 liq) external {
        IV3PoolMint(pool).mint(address(this), lo, hi, liq, abi.encode(pool));
    }
    function uniswapV3MintCallback(uint256 owed0, uint256 owed1, bytes calldata) external {
        TestToken(IV3PoolMint(msg.sender).token0()).transfer(msg.sender, owed0);
        TestToken(IV3PoolMint(msg.sender).token1()).transfer(msg.sender, owed1);
    }
}

// Stand-in for Arbitrum's ArbSys at address 0x64 on the local chain: always says block `n`.
contract ArbSysStub {
    function arbBlockNumber() external pure returns (uint256) { return 123456789; }
}
