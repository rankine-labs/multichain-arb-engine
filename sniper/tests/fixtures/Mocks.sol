// SPDX-License-Identifier: MIT
// ============================================================================
// TEST-ONLY mocks for the sell-check (scam check) tests. Never deployed to a
// real chain. They copy the parts of Four.meme the check relies on:
//   - MockTokenManager: same function names/selectors as TokenManager2
//     (buyTokenAMAP(address,uint256,uint256), sellToken(address,uint256)) and
//     the SAME TokenPurchase / TokenSale events, on a simple curve with a 1% fee
//   - MockToken: a plain ERC20 that can be made nasty:
//       buyTaxBps  > 0  -> takes a cut when tokens leave the manager (buy tax)
//       sellBlocked     -> refuses transfers back to the manager (can't sell)
// Compiled with tests/fixtures/compile.js (solc 0.8.24) into mocks.json.
// ============================================================================
pragma solidity 0.8.24;

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public manager;
    uint256 public buyTaxBps;
    bool public sellBlocked;

    constructor(address _manager, uint256 supply, uint256 _buyTaxBps, bool _sellBlocked) {
        manager = _manager;
        buyTaxBps = _buyTaxBps;
        sellBlocked = _sellBlocked;
        balanceOf[_manager] = supply;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        _move(msg.sender, to, a);
        return true;
    }

    function transferFrom(address from, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[from][msg.sender];
        require(al >= a, "allowance");
        if (al != type(uint256).max) allowance[from][msg.sender] = al - a;
        _move(from, to, a);
        return true;
    }

    function _move(address from, address to, uint256 a) internal {
        require(balanceOf[from] >= a, "balance");
        if (sellBlocked && to == manager && from != manager) revert("sell blocked");
        balanceOf[from] -= a;
        uint256 tax = from == manager ? (a * buyTaxBps) / 10000 : 0;
        balanceOf[to] += a - tax;
        balanceOf[address(0xdead)] += tax;
    }
}

contract MockTokenManager {
    event TokenPurchase(address token, address account, uint256 price, uint256 amount, uint256 cost, uint256 fee, uint256 offers, uint256 funds);
    event TokenSale(address token, address account, uint256 price, uint256 amount, uint256 cost, uint256 fee, uint256 offers, uint256 funds);

    uint256 constant VT = 273_000_000 ether; // virtual tokens (illustrative)
    uint256 constant VQ = 7 ether; // virtual quote (illustrative)
    mapping(address => uint256) public offers;
    mapping(address => uint256) public funds;

    function list(address token, uint256 amount) external {
        offers[token] = amount;
    }

    function buyTokenAMAP(address token, uint256 f, uint256 minAmount) external payable {
        require(msg.value == f, "value");
        uint256 fee = f / 101; // 1% on top of cost
        uint256 cost = f - fee;
        uint256 x = offers[token] + VT;
        uint256 y = funds[token] + VQ;
        uint256 out = x - (x * y + (y + cost) - 1) / (y + cost);
        require(out >= minAmount, "slippage");
        offers[token] -= out;
        funds[token] += cost;
        MockToken(token).transfer(msg.sender, out);
        emit TokenPurchase(token, msg.sender, (y + cost) * 1e18 / (x - out), out, cost, fee, offers[token], funds[token]);
    }

    function sellToken(address token, uint256 amount) external {
        MockToken(token).transferFrom(msg.sender, address(this), amount);
        uint256 x = offers[token] + VT;
        uint256 y = funds[token] + VQ;
        uint256 gross = y - (x * y + (x + amount) - 1) / (x + amount);
        uint256 fee = gross / 100;
        offers[token] += amount;
        funds[token] -= gross;
        payable(msg.sender).transfer(gross - fee);
        emit TokenSale(token, msg.sender, (y - gross) * 1e18 / (x + amount), amount, gross, fee, offers[token], funds[token]);
    }

    receive() external payable {}
}
