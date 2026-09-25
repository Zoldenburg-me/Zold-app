// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A raw ERC-20 interface, without OpenZeppelin's SafeERC20.
///
/// SafeERC20 guards against two things:
///
///  1. Ignoring the return value, so a token returning `false` looks like a
///     success. Not an issue here: every call below is require-wrapped.
///
///  2. Assuming a `bool` return exists. A token whose `transfer` returns
///     nothing (USDT) makes the decoder expect 32 bytes and revert, unwinding
///     a transfer that succeeded. Not possible here: `tokenIn` and `tokenOut`
///     are immutable and are EURe and USDC on every deployment, both returning
///     bools.
///
/// FxSwapper is also being retired. It holds inventory we fund and cannot be
/// executed by a user's Safe (onlyTrader), so LIQUIDITY_PROVIDER defaults to
/// `best` over lifi,dex and this stays as the local hardhat fixture.
///
/// If the token pair becomes mutable or this contract goes to production,
/// replace these with a low-level call that treats empty return data as
/// success and decodes a bool otherwise.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title FxSwapper — swaps EURe and USDC against its own inventory at an
/// owner-set rate. Stands in for a DEX aggregator route (Uniswap/Aerodrome on
/// Base) in the MVP; the interface is what the orchestrator codes against.
contract FxSwapper {
    IERC20 public immutable tokenIn; // EURe (18 decimals)
    IERC20 public immutable tokenOut; // USDC (6 decimals)
    address public owner;
    bool public paused;
    mapping(address => bool) public isTrader;

    /// tokenOut units (6dp) per 1e18 units of tokenIn.
    /// e.g. rate = 1_080_000 means 1 EURe -> 1.08 USDC.
    uint256 public rate;

    event RateSet(uint256 rate);
    event TraderSet(address indexed trader, bool enabled);
    event PausedSet(bool paused);
    event GuardianSet(address indexed guardian);
    event OwnershipTransferred(address indexed from, address indexed to);
    event Swapped(address indexed caller, uint256 amountIn, uint256 amountOut, address indexed to);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyTrader() {
        require(isTrader[msg.sender], "not trader");
        _;
    }

    modifier notPaused() {
        require(!paused, "paused");
        _;
    }

    constructor(address _tokenIn, address _tokenOut, uint256 _rate) {
        tokenIn = IERC20(_tokenIn);
        tokenOut = IERC20(_tokenOut);
        owner = msg.sender;
        rate = _rate;
    }

    /// Emergency stop. A guardian key can halt at once, without waiting out
    /// the timelock while funds drain. Restarting is the dangerous direction
    /// and stays with the owner (the timelock).
    address public guardian;

    function setGuardian(address who) external onlyOwner {
        guardian = who;
        emit GuardianSet(who);
    }

    function pause() external {
        require(msg.sender == guardian || msg.sender == owner, "not guardian");
        paused = true;
        emit PausedSet(true);
    }

    /// Hand the privileged role to a new owner — in practice the AdminTimelock.
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setRate(uint256 _rate) external onlyOwner {
        require(_rate > 0, "zero rate");
        rate = _rate;
        emit RateSet(_rate);
    }

    function setTrader(address who, bool enabled) external onlyOwner {
        isTrader[who] = enabled;
        emit TraderSet(who, enabled);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    function quoteOut(uint256 amountIn) public view returns (uint256) {
        return (amountIn * rate) / 1e18;
    }

    function quoteReverseOut(uint256 amountIn) public view returns (uint256) {
        return (amountIn * 1e18) / rate;
    }

    /// Pulls `amountIn` of tokenIn from the caller, pays out tokenOut to `to`.
    /// Reverts if the output is below `minOut` (slippage guard).
    function swapExactIn(uint256 amountIn, uint256 minOut, address to)
        external
        onlyTrader
        notPaused
        returns (uint256 amountOut)
    {
        amountOut = quoteOut(amountIn);
        require(amountOut >= minOut, "slippage");
        require(tokenOut.balanceOf(address(this)) >= amountOut, "no inventory");
        require(tokenIn.transferFrom(msg.sender, address(this), amountIn), "pull failed");
        require(tokenOut.transfer(to, amountOut), "payout failed");
        emit Swapped(msg.sender, amountIn, amountOut, to);
    }

    /// Pulls tokenOut from the caller, pays tokenIn back to `to`.
    /// Example: USDC -> EURe using the inverse of `rate`.
    function swapReverseExactIn(uint256 amountIn, uint256 minOut, address to)
        external
        onlyTrader
        notPaused
        returns (uint256 amountOut)
    {
        amountOut = quoteReverseOut(amountIn);
        require(amountOut >= minOut, "slippage");
        require(tokenIn.balanceOf(address(this)) >= amountOut, "no inventory");
        require(tokenOut.transferFrom(msg.sender, address(this), amountIn), "pull failed");
        require(tokenIn.transfer(to, amountOut), "payout failed");
        emit Swapped(msg.sender, amountIn, amountOut, to);
    }

    /// Owner can withdraw inventory (treasury rebalancing).
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        require(IERC20(token).transfer(to, amount), "withdraw failed");
    }
}
