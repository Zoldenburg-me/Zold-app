import { SafeMultiChainSigAccountV1 as S, SafeAccountFactory } from "abstractionkit";
const Safe_L2_V1_4_1 = { singletonAddress: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762", singletonInitHash: "0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee" };
import { keccak256, solidityPackedKeccak256, solidityPacked, getAddress } from "ethers";
const x = BigInt(process.argv[2] ?? "0x" + "11".repeat(32));
const y = BigInt(process.argv[3] ?? "0x" + "22".repeat(32));
const init = S.createInitializerCallData([{ x, y }], 1);
const initHash = keccak256(init);
const factory = SafeAccountFactory.DEFAULT_FACTORY_ADDRESS;
const initCodeHash = Safe_L2_V1_4_1.singletonInitHash;
const addr = (n) => getAddress("0x" + solidityPackedKeccak256(["bytes1","address","bytes32","bytes32"],
  ["0xff", factory, keccak256(solidityPacked(["bytes32","uint256"],[initHash, n])), initCodeHash]).slice(-40));
console.log(JSON.stringify({ factory, singleton: Safe_L2_V1_4_1.singletonAddress ?? null, initCodeHash, initializer: init, initializerHash: initHash,
  address_nonce0: addr(0n), sdk_address: S.createAccountAddress([{ x, y }]), address_nonce1: addr(1n), sdk_nonce1: S.createAccountAddress([{x,y}], { c2Nonce: 1n }) }, null, 2));
