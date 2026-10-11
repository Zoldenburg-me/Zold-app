// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISocialRecoveryModule {
    function confirmRecovery(address wallet, address[] calldata newOwners, uint256 newThreshold, bool execute) external;
}

/**
 * Test fixture: a guardian that is a contract, not a key. It confirms a
 * recovery by calling Candide's SocialRecoveryModule itself, so the module
 * sees the contract as msg.sender — the path a TOTP guardian would take once
 * its own check passes. Here the check is "the deployer asked", which is all
 * the fork test needs to prove the module accepts a contract guardian.
 */
contract StubContractGuardian {
    address public immutable operator;

    constructor() {
        operator = msg.sender;
    }

    function confirm(
        address module,
        address wallet,
        address[] calldata newOwners,
        uint256 newThreshold,
        bool execute
    ) external {
        require(msg.sender == operator, "not operator");
        ISocialRecoveryModule(module).confirmRecovery(wallet, newOwners, newThreshold, execute);
    }
}
