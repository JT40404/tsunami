#!/usr/bin/env node
/**
 * TSUNAMI fee bot (non-custodial)
 *
 * Runs on the creator's own machine with the creator's own wallet. Each cycle it:
 *   1. collects the token's pump.fun creator fees into the wallet
 *      (or, for a coin with fee sharing, triggers the permissionless distribution,
 *       which pays every shareholder, including the platform's 10%),
 *   2. spends what the wallet holds above its reserve, in the token's pair asset
 *      (SOL, or PUMP for a PUMP-paired coin; no conversion step),
 *   3. splits that spend by the burn / liquidity ratio for the current phase:
 *        on the curve  -> buy, burn the burn share, hold the rest for liquidity
 *        after migration -> buy and burn the burn share; the liquidity share buys
 *                           tokens with half and deposits both halves (plus any
 *                           tokens held from the curve) into the PumpSwap pool
 *   4. burns the LP tokens it receives, if lpTokens is "burn".
 *
 * Use a dedicated wallet: everything above `solReserve` (SOL-paired) or the whole
 * quote balance (token-paired) is treated as budget to spend.
 *
 * Usage:
 *   node bot.mjs --check   validate config and show what the bot sees, sends nothing
 *   node bot.mjs --once    run one cycle
 *   node bot.mjs           run every `intervalMinutes`
 * With "dryRun": true every transaction is simulated instead of sent.
 */
import fs from "node:fs";
import path from "node:path";
import BN from "bn.js";
import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, getAccount, getMint, createBurnCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction, NATIVE_MINT, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createRequire } from "node:module";
// The pump SDKs are loaded through their CommonJS builds: the ESM build of @pump-fun/pump-sdk 4.2.0
// pulls in a dependency whose ESM import of bn.js from @coral-xyz/anchor fails under Node.
const require = createRequire(import.meta.url);
const {
  OnlinePumpSdk, PUMP_SDK, feeSharingConfigPda, canonicalPumpPoolPdaWithQuote,
  getBuyV3TokenAmountFromQuoteAmount,
} = require("@pump-fun/pump-sdk");
const { OnlinePumpAmmSdk, PUMP_AMM_SDK } = require("@pump-fun/pump-swap-sdk");

/* ───────── config ───────── */
const args = new Set(process.argv.slice(2));
const CONFIG_PATH = process.env.BOT_CONFIG || "./config.json";
const LOG_PATH = process.env.BOT_LOG || "./activity.log";

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) die(`No ${CONFIG_PATH}. Copy config.example.json to config.json and fill it in.`);
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const pct = (v, name) => { if (typeof v !== "number" || v < 0 || v > 100) die(`${name} must be a number from 0 to 100`); return v; };
  if (!c.rpcUrl) die("rpcUrl is required");
  try { new PublicKey(c.mint); } catch { die("mint is not a valid address"); }
  pct(c.split?.curve?.burnPct, "split.curve.burnPct");
  pct(c.split?.pool?.burnPct, "split.pool.burnPct");
  if (!["burn", "keep"].includes(c.lpTokens)) die('lpTokens must be "burn" or "keep"');
  pct(c.slippagePct ?? 5, "slippagePct");
  return { slippagePct: 5, intervalMinutes: 10, minSpend: 0.05, solReserve: 0.05, dryRun: true, ...c };
}
function loadWallet(p) {
  const file = path.resolve(p);
  if (!fs.existsSync(file)) die(`Wallet file not found: ${file}`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}
function die(msg) { console.error("✖ " + msg); process.exit(1); }

/* ───────── logging ───────── */
const ts = () => new Date().toISOString();
function log(msg, extra) { console.log(`[${ts()}] ${msg}`); if (extra) record({ msg, ...extra }); }
function record(entry) { fs.appendFileSync(LOG_PATH, JSON.stringify({ t: ts(), ...entry }) + "\n"); }

/* ───────── amounts ───────── */
const toUi = (bn, dec) => Number(bn.toString()) / 10 ** dec;
const fromUi = (n, dec) => new BN(Math.floor(n * 10 ** dec).toString());
const pctOf = (bn, pct) => bn.mul(new BN(Math.round(pct * 100))).div(new BN(10_000));

/* ───────── chain helpers ───────── */
async function programOf(conn, mint) {
  const info = await conn.getAccountInfo(mint);
  if (!info) throw new Error(`Account not found: ${mint.toBase58()}`);
  return info.owner;
}
async function tokenBalance(conn, owner, mint, tokenProgram) {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  try { return new BN((await getAccount(conn, ata, "confirmed", tokenProgram)).amount.toString()); }
  catch { return new BN(0); }
}
/** What the bot may spend in the pair asset: lamports above the reserve, or the full token balance. */
async function spendableQuote(ctx) {
  const { conn, wallet, quoteMint, quoteTokenProgram, cfg } = ctx;
  if (quoteMint.equals(NATIVE_MINT)) {
    const lamports = new BN(await conn.getBalance(wallet.publicKey, "confirmed"));
    const reserve = new BN(Math.floor(cfg.solReserve * LAMPORTS_PER_SOL));
    return BN.max(lamports.sub(reserve), new BN(0));
  }
  return tokenBalance(conn, wallet.publicKey, quoteMint, quoteTokenProgram);
}

async function send(ctx, label, instructions) {
  const { conn, wallet, cfg } = ctx;
  if (!instructions.length) return null;
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ...instructions,
  );
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash; tx.feePayer = wallet.publicKey; tx.sign(wallet);
  if (cfg.dryRun) {
    const sim = await conn.simulateTransaction(tx);
    if (sim.value.err) {
      log(`  ✖ ${label} (simulated) failed: ${JSON.stringify(sim.value.err)}`);
      (sim.value.logs || []).slice(-8).forEach(l => console.log("     " + l));
      throw new Error(`${label} simulation failed`);
    }
    log(`  ✓ ${label} (simulated, not sent)`);
    return "SIMULATED";
  }
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  log(`  ✓ ${label}: https://solscan.io/tx/${sig}`);
  return sig;
}

/* ───────── step 1: collect fees ───────── */
// v3 curve trades and v2 pool trades leave creator fees waiting on the curve / pool until a
// permissionless sweep moves them to the creator vault, so every claim sweeps first, in the same
// transaction (pump.fun docs: SWEEP_FEES.md).
async function pendingFees(ctx, creatorKey) {
  const { pump, amm, quoteMint, curve, phase } = ctx;
  const vault = (await pump.getCreatorVaultQuoteBalances(creatorKey, [quoteMint])).find(b => b.mint.equals(quoteMint));
  let total = new BN(curve.creatorFee || 0).add(vault ? vault.total : new BN(0));
  if (phase === 2) {
    const pool = await amm.fetchPool(canonicalPumpPoolPdaWithQuote(ctx.mint, quoteMint)).catch(() => null);
    if (pool?.creatorFees) total = total.add(pool.creatorFees);
  }
  return total;
}

async function collectFees(ctx) {
  const { conn, pump, wallet, mint, quoteMint, quoteTokenProgram, curve, phase } = ctx;
  const sharing = feeSharingConfigPda(mint);
  const sharingInfo = await conn.getAccountInfo(sharing);

  if (sharingInfo && curve.creator.equals(sharing)) {
    // Fee-sharing coin (launchpad coins): distribution is permissionless and pays every
    // shareholder in one go, including the platform's share.
    const pending = await pendingFees(ctx, sharing);
    if (pending.isZero()) { log("  no creator fees waiting"); return; }
    log(`  about ${toUi(pending, ctx.quoteDecimals)} ${ctx.quoteSymbol} in creator fees waiting; distributing to all shareholders`);
    const { instructions } = await pump.buildDistributeCreatorFeesInstructions(mint, { quoteMint, quoteTokenProgram, payer: wallet.publicKey });
    try {
      const sig = await send(ctx, "sweep + distribute creator fees", instructions);
      record({ type: "distribute", tx: sig, amount: toUi(pending, ctx.quoteDecimals), quote: ctx.quoteSymbol });
    } catch (e) { log("  distribution not possible yet (often: below pump.fun's minimum); will retry next cycle"); }
    return;
  }

  if (curve.creator.equals(wallet.publicKey)) {
    // Single-creator coin: this wallet is the creator and collects directly.
    const pending = await pendingFees(ctx, wallet.publicKey);
    if (pending.isZero()) { log("  no creator fees waiting"); return; }
    log(`  collecting about ${toUi(pending, ctx.quoteDecimals)} ${ctx.quoteSymbol} in creator fees`);
    const ixs = [await PUMP_SDK.sweepCreatorFeeInstruction({ payer: wallet.publicKey, mint, creator: wallet.publicKey, quoteMint, quoteTokenProgram })];
    if (phase === 2) ixs.push(await PUMP_SDK.sweepPoolCreatorFeeInstruction({ payer: wallet.publicKey, mint, coinCreator: wallet.publicKey, quoteMint, quoteTokenProgram }));
    if (!quoteMint.equals(NATIVE_MINT)) {
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey,
        getAssociatedTokenAddressSync(quoteMint, wallet.publicKey, false, quoteTokenProgram), wallet.publicKey, quoteMint, quoteTokenProgram));
    }
    ixs.push(...await pump.collectCoinCreatorFeeV2Instructions(wallet.publicKey, quoteMint, quoteTokenProgram, wallet.publicKey));
    const sig = await send(ctx, "sweep + collect creator fees", ixs);
    record({ type: "collect", tx: sig, amount: toUi(pending, ctx.quoteDecimals), quote: ctx.quoteSymbol });
    return;
  }
  log("  this wallet is not the coin creator and the coin has no fee sharing; spending what it already holds");
}

/* ───────── burning ───────── */
async function burnTokens(ctx, amount, label) {
  if (amount.isZero()) return null;
  const { wallet, mint, baseTokenProgram, baseDecimals } = ctx;
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey, false, baseTokenProgram);
  const ix = createBurnCheckedInstruction(ata, mint, wallet.publicKey, BigInt(amount.toString()), baseDecimals, [], baseTokenProgram);
  const sig = await send(ctx, `${label}: burn ${toUi(amount, baseDecimals).toLocaleString()} tokens`, [ix]);
  record({ type: "burn", tx: sig, tokens: toUi(amount, baseDecimals), phase: ctx.phase });
  return sig;
}

/* ───────── phase 1: on the bonding curve ───────── */
async function spendOnCurve(ctx, budget) {
  const { conn, pump, wallet, mint, quoteMint, cfg } = ctx;
  const burnPct = cfg.split.curve.burnPct;
  const [global, feeConfig, buyState, mintInfo] = await Promise.all([
    pump.fetchGlobal(), pump.fetchFeeConfig(),
    pump.fetchBuyState(mint, wallet.publicKey, ctx.baseTokenProgram, quoteMint),
    getMint(conn, mint, "confirmed", ctx.baseTokenProgram),
  ]);
  const expected = getBuyV3TokenAmountFromQuoteAmount({
    global, feeConfig, mintSupply: new BN(mintInfo.supply.toString()), bondingCurve: buyState.bondingCurve,
    amount: budget, curveBaseTokenBalance: buyState.curveBaseTokenBalance, quoteTransferFee: buyState.quoteTransferFee,
  });
  if (expected.isZero()) { log("  curve buy would return nothing; skipping"); return; }

  const before = await tokenBalance(conn, wallet.publicKey, mint, ctx.baseTokenProgram);
  const ixs = await PUMP_SDK.buyExactQuoteInV3Instructions({
    bondingCurve: buyState.bondingCurve, associatedUserAccountInfo: buyState.associatedUserAccountInfo,
    mint, user: wallet.publicKey, amount: expected, quoteAmount: budget, slippage: cfg.slippagePct,
    tokenProgram: ctx.baseTokenProgram, quoteTokenProgram: buyState.quoteTokenProgram,
  });
  const sig = await send(ctx, `curve buy with ${toUi(budget, ctx.quoteDecimals)} ${ctx.quoteSymbol}`, ixs);
  const received = cfg.dryRun ? expected : (await tokenBalance(conn, wallet.publicKey, mint, ctx.baseTokenProgram)).sub(before);
  record({ type: "buyback", tx: sig, phase: 1, quote: ctx.quoteSymbol, spent: toUi(budget, ctx.quoteDecimals), tokens: toUi(received, ctx.baseDecimals) });

  const toBurn = pctOf(received, burnPct);
  if (!cfg.dryRun) await burnTokens(ctx, toBurn, "curve");
  else if (!toBurn.isZero()) log(`  would burn ${toUi(toBurn, ctx.baseDecimals).toLocaleString()} tokens (${burnPct}%)`);
  const held = received.sub(toBurn);
  if (!held.isZero()) log(`  holding ${toUi(held, ctx.baseDecimals).toLocaleString()} tokens for liquidity after migration`);
}

/* ───────── phase 2: on PumpSwap ───────── */
async function spendInPool(ctx, budget) {
  const { conn, amm, wallet, mint, cfg } = ctx;
  const poolKey = canonicalPumpPoolPdaWithQuote(mint, ctx.quoteMint);
  const burnQuote = pctOf(budget, cfg.split.pool.burnPct);
  const lpQuote = budget.sub(burnQuote);

  // Burn share: buy from the pool, then burn exactly what arrived.
  if (!burnQuote.isZero()) {
    const before = await tokenBalance(conn, wallet.publicKey, mint, ctx.baseTokenProgram);
    const state = await amm.swapSolanaState(poolKey, wallet.publicKey);
    const ixs = await PUMP_AMM_SDK.buyQuoteInput(state, burnQuote, cfg.slippagePct);
    const sig = await send(ctx, `pool buy (burn share) with ${toUi(burnQuote, ctx.quoteDecimals)} ${ctx.quoteSymbol}`, ixs);
    if (!cfg.dryRun) {
      const got = (await tokenBalance(conn, wallet.publicKey, mint, ctx.baseTokenProgram)).sub(before);
      record({ type: "buyback", tx: sig, phase: 2, quote: ctx.quoteSymbol, spent: toUi(burnQuote, ctx.quoteDecimals), tokens: toUi(got, ctx.baseDecimals) });
      await burnTokens(ctx, got, "pool");
    }
  }

  // Liquidity share: buy tokens with half, then deposit tokens + quote together.
  if (!lpQuote.isZero()) {
    const half = lpQuote.divn(2);
    if (!half.isZero()) {
      const state = await amm.swapSolanaState(poolKey, wallet.publicKey);
      const ixs = await PUMP_AMM_SDK.buyQuoteInput(state, half, cfg.slippagePct);
      const sig = await send(ctx, `pool buy (liquidity share) with ${toUi(half, ctx.quoteDecimals)} ${ctx.quoteSymbol}`, ixs);
      record({ type: "buyback", tx: sig, phase: 2, quote: ctx.quoteSymbol, spent: toUi(half, ctx.quoteDecimals), forLiquidity: true });
    }
    if (cfg.dryRun) { log(`  would deposit tokens + ${toUi(lpQuote.sub(half), ctx.quoteDecimals)} ${ctx.quoteSymbol} into the pool`); return; }
    await depositAll(ctx, poolKey, lpQuote.sub(half));
  }
}

/** Deposit every held token the quote budget can pair, or all the quote the held tokens can pair. */
async function depositAll(ctx, poolKey, quoteBudget) {
  const { conn, amm, wallet, mint, cfg } = ctx;
  const liq = await amm.liquiditySolanaState(poolKey, wallet.publicKey);
  const base = await tokenBalance(conn, wallet.publicKey, mint, ctx.baseTokenProgram);
  if (base.isZero() || quoteBudget.isZero()) { log("  nothing to deposit"); return; }

  let lpToken;
  const byBase = PUMP_AMM_SDK.depositBaseInput(liq, base, cfg.slippagePct);
  if (byBase.maxQuote.lte(quoteBudget)) lpToken = byBase.lpToken;
  else lpToken = PUMP_AMM_SDK.depositQuoteInput(liq, quoteBudget.muln(100).divn(100 + Math.ceil(cfg.slippagePct)), cfg.slippagePct).lpToken;
  if (lpToken.isZero()) { log("  deposit too small; carrying over"); return; }

  const lpMint = liq.pool.lpMint, lpProgram = await programOf(conn, lpMint);
  const lpBefore = await tokenBalance(conn, wallet.publicKey, lpMint, lpProgram);
  const ixs = await PUMP_AMM_SDK.depositInstructions(liq, lpToken, cfg.slippagePct);
  const sig = await send(ctx, "add liquidity", ixs);
  const lpGot = (await tokenBalance(conn, wallet.publicKey, lpMint, lpProgram)).sub(lpBefore);
  record({ type: "add_lp", tx: sig, phase: 2, quote: ctx.quoteSymbol, lpTokens: lpGot.toString() });

  if (ctx.cfg.lpTokens === "burn" && !lpGot.isZero()) {
    const lpDec = (await getMint(conn, lpMint, "confirmed", lpProgram)).decimals;
    const ata = getAssociatedTokenAddressSync(lpMint, wallet.publicKey, false, lpProgram);
    const ix = createBurnCheckedInstruction(ata, lpMint, wallet.publicKey, BigInt(lpGot.toString()), lpDec, [], lpProgram);
    const burnSig = await send(ctx, "burn LP tokens (liquidity locked for good)", [ix]);
    record({ type: "burn_lp", tx: burnSig, lpTokens: lpGot.toString() });
  } else if (!lpGot.isZero()) {
    log("  LP tokens kept in the wallet (lpTokens: keep)");
  }
}

/* ───────── one cycle ───────── */
async function buildContext(cfg) {
  const conn = new Connection(cfg.rpcUrl, "confirmed");
  const wallet = loadWallet(cfg.walletKeypair);
  const mint = new PublicKey(cfg.mint);
  const pump = new OnlinePumpSdk(conn);
  const amm = new OnlinePumpAmmSdk(conn);
  const baseTokenProgram = await programOf(conn, mint);
  const baseDecimals = (await getMint(conn, mint, "confirmed", baseTokenProgram)).decimals;
  return { cfg, conn, wallet, mint, pump, amm, baseTokenProgram, baseDecimals };
}

async function refresh(ctx) {
  const curveInfo = await ctx.conn.getAccountInfo(PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), ctx.mint.toBuffer()], new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"))[0]);
  if (!curveInfo) throw new Error("No pump.fun bonding curve for this mint. Is it a pump.fun coin?");
  const curve = PUMP_SDK.decodeBondingCurve(curveInfo);
  const quoteMint = curve.quoteMint.equals(PublicKey.default) ? NATIVE_MINT : curve.quoteMint;
  const quoteTokenProgram = quoteMint.equals(NATIVE_MINT) ? TOKEN_PROGRAM_ID : await programOf(ctx.conn, quoteMint);
  const quoteDecimals = quoteMint.equals(NATIVE_MINT) ? 9 : (await getMint(ctx.conn, quoteMint, "confirmed", quoteTokenProgram)).decimals;
  const quoteSymbol = quoteMint.equals(NATIVE_MINT) ? "SOL"
    : quoteMint.toBase58() === "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn" ? "PUMP" : quoteMint.toBase58().slice(0, 4) + "…";
  let phase = curve.complete ? 2 : 1;
  if (phase === 2) {
    const pool = await ctx.conn.getAccountInfo(canonicalPumpPoolPdaWithQuote(ctx.mint, quoteMint));
    if (!pool) phase = 1.5; // curve complete, pool not open yet
  }
  Object.assign(ctx, { curve, quoteMint, quoteTokenProgram, quoteDecimals, quoteSymbol, phase });
}

async function cycle(ctx) {
  await refresh(ctx);
  const { cfg } = ctx;
  log(`cycle · phase ${ctx.phase === 1 ? "1 (curve)" : ctx.phase === 2 ? "2 (PumpSwap)" : "migrating"} · pair ${ctx.quoteSymbol}${cfg.dryRun ? " · DRY RUN" : ""}`);
  if (ctx.phase === 1.5) { log("  curve complete, waiting for the pool to open"); return; }

  await collectFees(ctx);
  const budget = await spendableQuote(ctx);
  const minSpend = fromUi(cfg.minSpend, ctx.quoteDecimals);
  log(`  spendable: ${toUi(budget, ctx.quoteDecimals)} ${ctx.quoteSymbol} (minimum ${cfg.minSpend})`);
  if (budget.lt(minSpend)) { log("  below minimum; waiting for more fees"); return; }

  const split = ctx.phase === 1 ? cfg.split.curve : cfg.split.pool;
  log(`  split: ${split.burnPct}% burn / ${100 - split.burnPct}% liquidity`);
  if (ctx.phase === 1) await spendOnCurve(ctx, budget);
  else await spendInPool(ctx, budget);
}

async function check(ctx) {
  await refresh(ctx);
  const { cfg, wallet } = ctx;
  const sharing = feeSharingConfigPda(ctx.mint);
  const sharingInfo = await ctx.conn.getAccountInfo(sharing);
  console.log(`
  wallet        ${wallet.publicKey.toBase58()}
  token         ${ctx.mint.toBase58()} (${ctx.baseTokenProgram.equals(TOKEN_PROGRAM_ID) ? "SPL Token" : "Token-2022"}, ${ctx.baseDecimals} decimals)
  pair asset    ${ctx.quoteSymbol} (${ctx.quoteMint.toBase58()})
  phase         ${ctx.phase === 1 ? "1, on the bonding curve" : ctx.phase === 2 ? "2, on PumpSwap" : "migrating"}
  fee mode      ${sharingInfo && ctx.curve.creator.equals(sharing) ? "fee sharing (distribution pays all shareholders)"
                : ctx.curve.creator.equals(wallet.publicKey) ? "this wallet is the creator (collects directly)"
                : "this wallet does not receive creator fees directly"}
  curve split   ${cfg.split.curve.burnPct}% burn / ${100 - cfg.split.curve.burnPct}% liquidity
  pool split    ${cfg.split.pool.burnPct}% burn / ${100 - cfg.split.pool.burnPct}% liquidity
  LP tokens     ${cfg.lpTokens === "burn" ? "burned (liquidity is permanent)" : "kept in the wallet"}
  spendable     ${toUi(await spendableQuote(ctx), ctx.quoteDecimals)} ${ctx.quoteSymbol}
  SOL for gas   ${(await ctx.conn.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL} SOL${ctx.quoteMint.equals(NATIVE_MINT) ? "" : "  (needs a little SOL for fees: the pair asset is " + ctx.quoteSymbol + ")"}
  mode          ${cfg.dryRun ? "DRY RUN (transactions are simulated, nothing is sent)" : "LIVE (transactions are sent)"}
`);
}

/* ───────── main ───────── */
const cfg = loadConfig();
const ctx = await buildContext(cfg).catch(e => die(`Could not start: ${e.message}. Check rpcUrl, mint and your connection.`));
if (args.has("--check")) { await check(ctx).catch(e => die(e.message)); process.exit(0); }
if (args.has("--once")) { await cycle(ctx).catch(e => { log("✖ " + e.message); process.exitCode = 1; }); process.exit(); }
log(`fee bot started · every ${cfg.intervalMinutes} min${cfg.dryRun ? " · DRY RUN" : ""}`);
for (;;) {
  await cycle(ctx).catch(e => log("✖ cycle failed: " + e.message));
  await new Promise(r => setTimeout(r, cfg.intervalMinutes * 60_000));
}
