// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Test fixture: a contract wallet answering EIP-1271 the two ways a Safe
 * does. A message marked as signed on chain (Safe's SignMessageLib) is valid
 * with an empty signature; otherwise the signature must be the current
 * owner's over the hash. Changing the owner makes an old owner signature
 * invalid, as a Safe owner change does. Unlike a Safe, the owner signs the
 * hash itself, not a SafeMessage wrapper. Local hardhat only.
 */
contract Mock1271Wallet {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    address public owner;
    mapping(bytes32 => bool) public signedMessages;

    constructor(address initialOwner) {
        owner = initialOwner;
    }

    function setOwner(address next) external {
        require(msg.sender == owner, "not owner");
        owner = next;
    }

    function signMessage(bytes32 hash) external {
        require(msg.sender == owner, "not owner");
        signedMessages[hash] = true;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length == 0) {
            require(signedMessages[hash], "not signed");
            return MAGIC;
        }
        require(signature.length == 65, "bad signature length");
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        require(ecrecover(hash, v, r, s) == owner, "not the owner");
        return MAGIC;
    }
}
