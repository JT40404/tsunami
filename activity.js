// GET /api/activity
// Reads the buyback wallet's on-chain history (Helius Parsed Events) and turns it into
// buyback / burn / add_lp entries, each tagged with its phase:
//   phase 1 = on the pump.fun curve, phase 2 = after migration to PumpSwap.
import { env, json, migration, send, fail, requireEnv, PUMP, PUMP_AMM, WSOL, INCINERATOR, TOKEN_PROGRAMS } from "./_lib.js";

const MAX_PAGES = 5;
const url = path => `https://mainnet.helius-rpc.com${path}?api-key=${env.helius}`;

async function history() {
  const out = [];
  let paginationToken = null, useScan = true;
  for (let i = 0; i < MAX_PAGES; i++) {
    const body = { address: env.wallet, limit: 100, sortOrder: "desc", ...(paginationToken && { paginationToken }) };
    let page;
    try {
      // scan only returns transactions that touch our mint, which keeps credit use low
      page = useScan
        ? await json(url("/v1/parsed-events/scan"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, match: { mints: [{ mint: env.mint }] } }) })
        : await json(url("/v1/parsed-events/transaction-history"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      if (useScan && i === 0) { useScan = false; i = -1; continue; } // fall back to full history
      throw e;
    }
    out.push(...(page.data || []));
    paginationToken = page.paginationToken;
    if (!paginationToken) break;
  }
  return out;
}

const amountOf = t => {
  if (t.tokenAmount != null) return Number(t.tokenAmount);
  if (t.rawTokenAmount != null) {
    const raw = typeof t.rawTokenAmount === "object" ? t.rawTokenAmount.tokenAmount : t.rawTokenAmount;
    const dec = t.decimals ?? t.rawTokenAmount?.decimals ?? 6;
    return Number(raw) / 10 ** dec;
  }
  return 0;
};

function classify(item, migratedAt) {
  if (item.parserStatus && item.parserStatus !== "OK") return [];
  const p = item.parsed || item;
  if (p.error || p.transactionError) return [];
  const W = env.wallet, M = env.mint;
  const ts = (p.blockTime ?? p.timestamp) * 1000;
  const ins = p.instructions || [];
  const programs = new Set(ins.map(x => x.programId));
  const tt = p.tokenTransfers || [], nt = p.nativeTransfers || [];

  let tokIn = 0, tokOut = 0, burned = 0, solOut = 0;
  for (const t of tt) {
    const a = amountOf(t);
    if (t.mint === M) {
      if (t.toUserAccount === W) tokIn += a;
      if (t.fromUserAccount === W) {
        if (!t.toUserAccount || t.toUserAccount === INCINERATOR) burned += a;
        else tokOut += a;
      }
    }
    if (t.mint === WSOL) {
      if (t.fromUserAccount === W) solOut += a;
      if (t.toUserAccount === W) solOut -= a;
    }
  }
  for (const n of nt) {
    if (n.fromUserAccount === W) solOut += n.amount / 1e9;
    if (n.toUserAccount === W) solOut -= n.amount / 1e9;
  }
  // Real SPL burn instructions (these don't show up as transfers)
  if (!burned) {
    for (const x of ins) {
      if (!TOKEN_PROGRAMS.includes(x.programId) || !/^burn/i.test(x.instructionName || "")) continue;
      if (!JSON.stringify(x.decoded || x).includes(M)) continue;
      const args = x.decoded?.args || {};
      const raw = Number(args.amount ?? args.tokenAmount ?? 0);
      const dec = args.decimals ?? 6;
      burned += raw / 10 ** dec;
    }
  }

  const onCurve = programs.has(PUMP);
  const onAmm = programs.has(PUMP_AMM);
  const phase = onAmm ? 2 : onCurve ? 1 : migratedAt && ts >= migratedAt ? 2 : 1;
  const isDeposit = onAmm && ins.some(x => x.programId === PUMP_AMM && /deposit|add_?liquidity/i.test(x.instructionName || ""))
                 || p.summary?.type === "add_liquidity";

  const base = { tx: item.signature || p.signature, ts, phase };
  const out = [];
  if (isDeposit && tokOut > 0) out.push({ ...base, type: "add_lp", sol: Math.max(0, solOut), tokens: tokOut });
  else if (tokIn > 0 && solOut > 0) out.push({ ...base, type: "buyback", sol: solOut, tokens: tokIn });
  if (burned > 0) out.push({ ...base, type: "burn", sol: 0, tokens: burned });
  return out;
}

export default async function handler(req, res) {
  if (!requireEnv(res, "helius", "mint", "wallet")) return;
  try {
    const [items, mig] = await Promise.all([history(), migration()]);
    const entries = items.flatMap(it => classify(it, mig.at)).sort((a, b) => a.ts - b.ts);
    send(res, { wallet: env.wallet, migratedAt: mig.at, migrated: mig.migrated, count: entries.length, entries }, 120);
  } catch (e) {
    fail(res, e);
  }
}
