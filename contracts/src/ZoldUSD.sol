// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockToken} from "./MockToken.sol";

/// @title ZoldUSD (zUSD) — a staging dollar for testers on a test chain.
/// Testers use it instead of Circle's testnet USDC or EURC: the owner (the
/// faucet wallet) mints it, the faucet page drips it, and a Uniswap v3 pool
/// prices it against EURe. Worth nothing, and refuses to exist on a chain
/// where tokens carry real money.
///
/// The owner is an argument, not msg.sender: deployed through CreateX (for a
/// mined vanity address), msg.sender is CreateX's CREATE3 proxy, which could
/// never mint.
contract ZoldUSD is MockToken {
    constructor(address owner_) MockToken("ZoldUSD", "zUSD", 6) {
        require(owner_ != address(0), "zero owner");
        require(
            block.chainid != 1 && block.chainid != 8453 && block.chainid != 137 &&
                block.chainid != 100 && block.chainid != 42161 && block.chainid != 10,
            "zUSD is a test token"
        );
        owner = owner_;
    }
}
