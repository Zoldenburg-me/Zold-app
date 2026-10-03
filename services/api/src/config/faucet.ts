import { CHAIN_ID, envNumber, IS_REAL_MONEY_CHAIN } from "./env.js";

/**
 * Testnet faucet: EURe granted to each passkey Safe from the faucet wallet
 * (FAUCET_KEY), so a fresh test account has something to send. Off unless
 * both are set. Refused at startup on a chain where EURe is real money and in
 * production, so the key can never hold real euros for this purpose.
 */
export const TESTNET_FAUCET = (() => {
  const grantEur = envNumber("TESTNET_FAUCET_EUR", 0, { min: 0 });
  const raw = process.env.FAUCET_KEY?.trim();
  if (raw && !/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error("FAUCET_KEY is not a 32-byte hex private key");
  const drips = parseFaucetDrips(process.env.FAUCET_DRIPS);
  if ((raw || grantEur > 0 || drips.length) && IS_REAL_MONEY_CHAIN) {
    throw new Error(`FAUCET_KEY / TESTNET_FAUCET_EUR / FAUCET_DRIPS are testnet-only; chain ${CHAIN_ID} carries real EURe — unset them`);
  }
  return {
    grantEur,
    key: raw ? (raw as `0x${string}`) : undefined,
    /** The public faucet page's tokens: what one drip sends, per token. */
    drips,
    /** One drip per address and token in this window. */
    cooldownMs: envNumber("FAUCET_COOLDOWN_HOURS", 24, { min: 0 }) * 3600_000,
    /** Drips one IP may take in that window, across addresses and tokens. */
    perIpPerWindow: envNumber("FAUCET_DRIPS_PER_IP", 6, { min: 1, integer: true }),
    /** Drips per token in that window, all callers together. */
    perTokenPerWindow: envNumber("FAUCET_DRIPS_PER_TOKEN", 50, { min: 1, integer: true }),
  };
})();

/**
 * FAUCET_DRIPS: `SYMBOL:amount` for the app's own EURe and USDC (their
 * addresses come from deployments.json), or `SYMBOL:0xaddress:amount` for any
 * other token on the app chain — e.g. `EURe:100,USDC:5,EURC:0x8084…359F:5`.
 */
function parseFaucetDrips(raw: string | undefined): { symbol: string; address?: `0x${string}`; amount: number }[] {
  if (!raw?.trim()) return [];
  return raw.split(",").map((part) => {
    const bits = part.trim().split(":");
    const [symbol, address, amountText] = bits.length === 3 ? bits : [bits[0], undefined, bits[1]];
    const amount = Number(amountText);
    if (!/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(symbol ?? "")) throw new Error(`FAUCET_DRIPS: "${part}" has no valid token symbol`);
    if (address !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`FAUCET_DRIPS: "${part}" has no valid token address`);
    if (address === undefined && !/^(EURe|USDC)$/.test(symbol)) {
      throw new Error(`FAUCET_DRIPS: "${part}" needs an address — only EURe and USDC are known from deployments.json`);
    }
    if (!(amount > 0)) throw new Error(`FAUCET_DRIPS: "${part}" needs a positive amount`);
    return { symbol, ...(address ? { address: address as `0x${string}` } : {}), amount };
  });
}
