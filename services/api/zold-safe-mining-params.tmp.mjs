// Vanity-mining parameters for an EOA-owned Safe with Zold's 4337 setup.
// usage: node zold-safe-mining-params.tmp.mjs <eoaAddress> [saltNonce]
import { SafeMultiChainSigAccountV1 as S, SafeAccountFactory } from "abstractionkit";
import { keccak256, solidityPackedKeccak256, solidityPacked, getAddress, Interface } from "ethers";
const SINGLETON = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const INIT_CODE_HASH = "0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee";
const eoa = getAddress(process.argv[2] ?? "0x000000000000000000000000000000000000dEaD");
const nonce = BigInt(process.argv[3] ?? 0);
const init = S.createInitializerCallData([eoa], 1);
const initHash = keccak256(init);
const factory = SafeAccountFactory.DEFAULT_FACTORY_ADDRESS;
const addr = (n) => getAddress("0x" + solidityPackedKeccak256(["bytes1","address","bytes32","bytes32"],
  ["0xff", factory, keccak256(solidityPacked(["bytes32","uint256"], [initHash, n])), INIT_CODE_HASH]).slice(-40));
const deployData = new Interface(["function createProxyWithNonce(address,bytes,uint256)"]).encodeFunctionData("createProxyWithNonce", [SINGLETON, init, nonce]);
const decoded = new Interface(["function setup(address[],uint256,address,bytes,address,address,uint256,address)"]).decodeFunctionData("setup", init);
console.log(JSON.stringify({
  owner: eoa, factory, singleton: SINGLETON, initCodeHash: INIT_CODE_HASH,
  initializer: init, initializerHash: initHash,
  setup: { owners: decoded[0], threshold: decoded[1].toString(), to: decoded[2], fallbackHandler: decoded[4] },
  saltNonce: nonce.toString(), address: addr(nonce), sdkAddressCheck: S.createAccountAddress([eoa], { c2Nonce: nonce }),
  deployTx: { to: factory, data: deployData, value: "0" },
}, null, 2));
