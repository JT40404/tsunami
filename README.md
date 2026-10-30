# TSUNAMI-OS

Live tracker for the TSUNAMI token.

- **Phase 1 (on the pump.fun curve):** buybacks are burned, so supply shrinks.
- **Phase 2 (after migration to PumpSwap):** buybacks are added to the pool, so liquidity grows.

## What's in here

| file | does |
|---|---|
| `index.html` | the whole site |
| `api/token.js` | supply, mint/freeze authority, bonding-curve progress, migration status, labelled top holders (Helius RPC) |
| `api/activity.js` | reads the buyback wallet's history (Helius Parsed Events) and detects buybacks, burns and liquidity adds |
| `api/ohlcv.js` | price candles from CoinGecko Pro, stitched across the curve and PumpSwap pools |
| `api/_lib.js` | shared helpers (not a route) |

Your API keys only live in the server environment. Responses are cached at the edge
(15s token, 60s chart, 120s buybacks), so a thousand visitors cost about the same as one.

## Deploy on Vercel

1. Put this folder in a GitHub repo, then on vercel.com choose **Add New → Project** and import it.
   (Or install the CLI and run `npx vercel` inside this folder.)
2. In **Project → Settings → Environment Variables**, add the four values from `.env.example`:
   - `HELIUS_API_KEY`
   - `CG_PRO_API_KEY`
   - `TOKEN_MINT`: your token's mint address
   - `BUYBACK_WALLET`: the wallet you do every buyback, burn and liquidity add from
3. Redeploy. Open the site; the sidebar should show **mode: api** and every line **ok**.

To test locally with the functions: `npx vercel dev`, using a `.env` file copied from `.env.example`.
Opening `index.html` directly shows demo data (add `?phase=1` to preview phase 1).

## Rules for the buyback wallet

Detection works by watching one wallet, so:

- Do every buyback, burn and liquidity add from `BUYBACK_WALLET`.
- Phase 1: buy on the curve, then burn (same transaction or a separate one, both are detected).
  Burns are detected as SPL burn instructions or transfers to the incinerator address.
- Phase 2: buy on PumpSwap, then deposit into the TSUNAMI/SOL pool from the same wallet.
- Don't use that wallet for anything else involving TSUNAMI, or it will show up on the site.

If something is misread, fix it without code changes in `index.html`:
`CONFIG.hide` drops a transaction signature, `CONFIG.extra` adds an entry by hand.

## Edit in index.html

`CONFIG` at the bottom of the file: links, `liquidityGoalSol`, `roadmapDone`.
The project.txt story paragraph is in the HTML. Search for "Replace this paragraph".
