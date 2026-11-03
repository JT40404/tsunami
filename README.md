# TSUNAMI

## Files

| file | what it is |
|---|---|
| `index.html` | **The live site.** A landing page explaining the build-then-burn model, plus a live market page for your CA. No keys or backend needed. |
| `full.html` | The original full site: phases, supply, buyback log, project and contract pages. Needs the `api/` functions. |
| `api/` | Serverless functions used only by `full.html` (Helius + CoinGecko Pro). |
| `package.json`, `.env.example` | Setup for the `api/` functions. |
| `bot/` | The fee bot: collects creator fees and spends them on buybacks, burns and liquidity. Runs on your own machine. See `bot/README.md`. |

## Set your contract address

In `index.html`, find `CONFIG` near the top of the `<script>` and paste your CA:

```js
mint: "YourTokenAddressHere",
```

Until it's set, the page shows demo data.

## Deploy (Vercel)

Import the GitHub repo on vercel.com. `index.html` works with no settings.

`full.html` (at yoursite.com/full.html) only works if you also add these environment variables in
Vercel → Project → Settings → Environment Variables:
`HELIUS_API_KEY`, `CG_PRO_API_KEY`, `TOKEN_MINT`, `BUYBACK_WALLET`
(optional `QUOTE_MINT`, `QUOTE_SYMBOL`; PUMP is the default pair). If you don't need it, leave them out.

To switch the full site back to being the homepage, rename `full.html` to `index.html`
(and the current `index.html` to something else).

## Update

```bash
git add -A
git commit -m "update"
git push
```
