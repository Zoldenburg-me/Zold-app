// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title OffchainResolver
 * @notice ENSIP-10 wildcard resolver for `<handle>.<parent>` names, answered by
 *         the Zold API through CCIP-Read (ERC-3668).
 *
 * `resolve` never answers on-chain. It reverts with OffchainLookup, naming the
 * gateway URL, and the wallet fetches the answer there and returns it through
 * `resolveWithProof`. An answer is accepted only if one of `signers` signed it,
 * it has not expired, and it was signed for this resolver and this exact
 * request.
 *
 * Adapted from ensdomains/offchain-resolver (MIT). The signature hash is the
 * same, so its gateway tooling interoperates, but there is no OpenZeppelin
 * dependency: the signature recovery below is the only borrowed piece.
 *
 * The owner can change the gateway URL and the signer set, and so can
 * redirect every name. Hold it in a hardware wallet, like the guardian key.
 *
 * The signature binds this resolver's address but not the chain id (as
 * upstream does, to keep its tooling compatible). A resolver at the same
 * address on another chain that trusted the same signer would accept the
 * same answers. So mainnet and Sepolia get different gateway keys.
 */
contract OffchainResolver {
    error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData);

    /// ERC-3668 URL template, e.g. https://zoldhq.com/api/ens/gateway/{sender}/{data}.json
    string public url;
    address public owner;
    address public pendingOwner;
    mapping(address => bool) public signers;

    event UrlChanged(string url);
    event SignerChanged(address indexed signer, bool allowed);
    event OwnerChanged(address indexed owner);

    /// Upper half of secp256k1's order: a larger s is the malleable twin of a
    /// valid signature and is refused.
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(string memory _url, address[] memory _signers) {
        owner = msg.sender;
        url = _url;
        emit OwnerChanged(msg.sender);
        emit UrlChanged(_url);
        for (uint256 i = 0; i < _signers.length; i++) {
            signers[_signers[i]] = true;
            emit SignerChanged(_signers[i], true);
        }
    }

    function setUrl(string calldata _url) external onlyOwner {
        url = _url;
        emit UrlChanged(_url);
    }

    function setSigner(address signer, bool allowed) external onlyOwner {
        signers[signer] = allowed;
        emit SignerChanged(signer, allowed);
    }

    /// Two steps, so a mistyped address cannot take the resolver.
    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner && msg.sender != address(0), "not pending owner");
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnerChanged(msg.sender);
    }

    /// ENSIP-10: `name` is DNS-encoded, `data` is the resolver call (addr, text...).
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory) {
        bytes memory callData = abi.encodeWithSelector(this.resolve.selector, name, data);
        string[] memory urls = new string[](1);
        urls[0] = url;
        revert OffchainLookup(address(this), urls, callData, this.resolveWithProof.selector, callData);
    }

    /// `response` is abi.encode(result, expires, signature) from the gateway;
    /// `extraData` is the request the gateway was asked, as resolve() built it.
    function resolveWithProof(bytes calldata response, bytes calldata extraData) external view returns (bytes memory) {
        (bytes memory result, uint64 expires, bytes memory sig) = abi.decode(response, (bytes, uint64, bytes));
        require(expires >= block.timestamp, "signature expired");
        address signer = recover(makeSignatureHash(address(this), expires, extraData, result), sig);
        require(signers[signer], "invalid signature");
        return result;
    }

    function makeSignatureHash(address target, uint64 expires, bytes memory request, bytes memory result)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(hex"1900", target, expires, keccak256(request), keccak256(result)));
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x9061b923 /* IExtendedResolver */ || interfaceId == 0x01ffc9a7; /* ERC-165 */
    }

    function recover(bytes32 hash, bytes memory sig) private pure returns (address) {
        require(sig.length == 65, "bad signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "bad signature v");
        require(uint256(s) <= HALF_ORDER, "bad signature s");
        address signer = ecrecover(hash, v, r, s);
        require(signer != address(0), "invalid signature");
        return signer;
    }
}
