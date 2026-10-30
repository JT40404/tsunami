// GET /api/ohlcv?tf=15m
// Candles from CoinGecko Pro (onchain). Stitches the pump.fun curve pool and the PumpSwap pool
// together at the migration time, so the chart runs through both phases.
import { env, json, migration, send, fail, requireEnv } from "./_lib.js";

const BASE = "https://pro-api.coingecko.com/api/v3/onchain/networks/solana";
const TF = { "5m": ["minute", 5, 288], "15m": ["minute", 15, 300], "1h": ["hour", 1, 300], "4h": ["hour", 4, 300], "1d": ["day", 1, 300] };

const cg = path => json(BASE + path, { headers: { accept: "application/json", "x-cg-pro-api-key": env.cg } });
const rows = j => (j?.data?.attributes?.ohlcv_list || []).map(r => r.map(Number));

export default async function handler(req, res) {
  if (!requireEnv(res, "cg", "mint")) return;
  const tf = TF[req.query.tf] ? req.query.tf : "15m";
  const [unit, agg, limit] = TF[tf];
  const q = `${unit}?aggregate=${agg}&limit=${limit}&currency=usd&token=${env.mint}`;
  try {
    const [pools, mig] = await Promise.all([cg(`/tokens/${env.mint}/pools?page=1`).catch(() => null), migration()]);
    const list = (pools?.data || []).map(p => ({ address: p.attributes?.address, dex: p.relationships?.dex?.data?.id || "" }));
    const curvePool = list.find(p => p.dex === "pump-fun");
    const ammPool = list.find(p => p.dex !== "pump-fun" && /pump/.test(p.dex)) || list.find(p => p.dex !== "pump-fun");

    let candles = [], source = "coingecko";
    if (curvePool || ammPool) {
      const [a, b] = await Promise.all([
        curvePool ? cg(`/pools/${curvePool.address}/ohlcv/${q}`).then(rows).catch(() => []) : [],
        ammPool ? cg(`/pools/${ammPool.address}/ohlcv/${q}`).then(rows).catch(() => []) : [],
      ]);
      const cut = mig.at ? mig.at / 1000 : null;
      if (a.length && b.length && cut) candles = [...a.filter(c => c[0] < cut), ...b.filter(c => c[0] >= cut)];
      else candles = b.length ? b : a;
    }
    if (!candles.length) {
      // Fallback: CoinGecko picks the most liquid pool on its own.
      candles = rows(await cg(`/tokens/${env.mint}/ohlcv/${unit}?aggregate=${agg}&limit=${limit}&currency=usd`));
      source = "coingecko (top pool)";
    }
    candles.sort((x, y) => x[0] - y[0]);
    send(res, { tf, source, migratedAt: mig.at, candles }, 60);
  } catch (e) {
    fail(res, e);
  }
}
