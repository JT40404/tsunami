// Shared helpers for the TSUNAMI serverless functions (Vercel).
// Files starting with "_" are not exposed as routes.

export const env = {
  helius: process.env.HELIUS_API_KEY,
  cg: process.env.CG_PRO_API_KEY,
  mint: process.env.TOKEN_MINT,
  wallet: process.env.BUYBACK_WALLET,
  // The asset TSUNAMI is paired with. Defaults to PUMP (pump.fun Custom Pairs).
  quote: process.env.QUOTE_MINT || "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
  quoteSymbol: process.env.QUOTE_SYMBOL || "PUMP",
};

export const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";       // pump.fun bonding curve program
export const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";   // PumpSwap (post-migration AMM)
export const WSOL = "So11111111111111111111111111111111111111112";
export const INCINERATOR = "1nc1nerator11111111111111111111111111111111";
export const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

export const heliusRpc = () => `https://mainnet.helius-rpc.com/?api-key=${env.helius}`;

export async function json(url, opt = {}) {
  const r = await fetch(url, opt);
  if (!r.ok) throw new Error(`${r.status} from ${url.split("?")[0]}`);
  return r.json();
}

export async function rpc(method, params) {
  const j = await json(heliusRpc(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// Find the pump.fun curve pair and the PumpSwap pair (if the token has migrated).
export async function migration() {
  try {
    const j = await json(`https://api.dexscreener.com/latest/dex/tokens/${env.mint}`);
    const pairs = (j.pairs || []).filter(p => p.chainId === "solana");
    const curve = pairs.find(p => p.dexId === "pumpfun");
    // Prefer the PumpSwap pool against our quote asset; ignore pools other people create elsewhere.
    const byLiq = (a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0);
    const amm = pairs.filter(p => p.dexId === "pumpswap" && p.quoteToken?.address === env.quote).sort(byLiq)[0]
             || pairs.filter(p => p.dexId === "pumpswap").sort(byLiq)[0];
    return {
      migrated: !!amm,
      at: amm?.pairCreatedAt || null,
      ammPool: amm?.pairAddress || null,
      ammDex: amm?.dexId || null,
      curvePair: curve?.pairAddress || null,
    };
  } catch {
    return { migrated: false, at: null, ammPool: null, ammDex: null, curvePair: null };
  }
}

// Edge-cache every response so all visitors share one upstream call.
export function send(res, body, seconds) {
  res.setHeader("Cache-Control", `public, s-maxage=${seconds}, stale-while-revalidate=${seconds * 5}`);
  res.status(200).json(body);
}

export function fail(res, err) {
  res.setHeader("Cache-Control", "no-store");
  res.status(502).json({ error: String(err?.message || err) });
}

export function requireEnv(res, ...keys) {
  const missing = keys.filter(k => !env[k]);
  if (missing.length) {
    fail(res, `Missing environment variables: ${missing.join(", ")}`);
    return false;
  }
  return true;
}
