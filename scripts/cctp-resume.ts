/**
 * Finish a CCTP bridge whose burn already landed.
 *
 * The burn is irreversible and the attestation is slow — Base Sepolia soft
 * finality runs well past pollIris's 5-minute default, so a timeout leaves
 * real USDC burned with nothing minted. That is a resumable state, not a
 * failure: the burn hash is all that is needed to pick it up again.
 *
 *   npm run cctp:resume <burnTxHash> [timeoutMinutes]
 */
import "./_test-env.js";
import { mintCctpToStellar, pollIris } from "../services/api/src/bridge/cctp.js";

const hash = process.argv[2] as `0x${string}` | undefined;
if (!hash) throw new Error("usage: npm run cctp:resume <burnTxHash> [timeoutMinutes]");
const minutes = Number(process.argv[3] ?? 30);
console.log(`resuming CCTP for burn ${hash}\nwaiting up to ${minutes}m for Circle's attestation…`);
const att = await pollIris(hash, minutes * 60_000);
console.log(`attestation received (message ${att.message.slice(0, 26)}…)`);
const stellarHash = await mintCctpToStellar(att, (h) => console.log(`  submitted Stellar tx ${h}`));
console.log(`\nMINTED ON STELLAR — ${stellarHash}`);
console.log(`https://stellar.expert/explorer/testnet/tx/${stellarHash}`);
