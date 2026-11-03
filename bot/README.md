# TSUNAMI fee bot

A small program you run yourself, with your own wallet. It collects your token's pump.fun creator
fees and spends them on buybacks, burns and liquidity, on a schedule. Nobody else holds your keys
or your fees.

## What it does each cycle

1. **Collects fees.**
   - Coins launched with fee sharing (the launchpad's 90% / 10% split): it triggers pump.fun's
     permissionless distribution, which pays every shareholder at once: 90% to this wallet,
     10% to the platform wallet.
   - Coins where this wallet is the creator: it collects the fees directly.
   - Either way it first runs pump.fun's fee sweep in the same transaction, because newer trades
     leave fees waiting on the curve or pool until swept.
2. **Spends them in the pair asset.** SOL for SOL-paired coins, PUMP for PUMP-paired coins.
   No conversion step.
3. **Splits the spend by your burn / liquidity setting** for the current phase:

   | | burn share | liquidity share |
   |---|---|---|
   | **On the curve** | buys on the curve, then burns | buys on the curve and holds the tokens |
   | **On PumpSwap** | buys from the pool, then burns | buys tokens with half, deposits them plus the other half (and any tokens held from the curve) into the pool |

4. **LP tokens:** with `"lpTokens": "burn"` (the default) the LP tokens from each deposit are
   burned, so that liquidity can never be withdrawn. With `"keep"` they stay in your wallet.

Every action is logged to the console and to `activity.log`, with Solscan links.

## Setup

You need Node.js 20 or newer.

```bash
cd bot
npm install
cp config.example.json config.json
```

**Use a dedicated wallet.** The bot treats everything the wallet holds as budget: all SOL above
`solReserve` on a SOL-paired coin, or the whole PUMP balance on a PUMP-paired coin. Don't run it on
a wallet with other funds in it.

1. Create a new wallet (e.g. `solana-keygen new -o wallet.json`) and fund it with a little SOL for
   transaction fees (0.1 SOL is plenty to start).
2. Make it receive your creator fees: launch from it, or make it the fee-sharing shareholder.
3. Fill in `config.json`:

| setting | meaning |
|---|---|
| `rpcUrl` | your Solana RPC URL (a free Helius key works) |
| `mint` | your token's mint address |
| `walletKeypair` | path to the wallet file |
| `split.curve.burnPct` | % of each spend burned while on the curve (the rest is held for liquidity) |
| `split.pool.burnPct` | % of each spend burned after migration (the rest goes into the pool) |
| `lpTokens` | `"burn"` to lock liquidity permanently, `"keep"` to hold the LP tokens |
| `slippagePct` | maximum slippage per trade, in % |
| `intervalMinutes` | how often a cycle runs |
| `minSpend` | don't spend until at least this much (in SOL or PUMP) is available |
| `solReserve` | SOL always left in the wallet for fees (SOL-paired coins) |
| `dryRun` | `true` simulates every transaction and sends nothing |

TSUNAMI's own setting, build on the curve and burn in the pool, is `curve.burnPct: 0` and
`pool.burnPct: 100`, which is what the example config uses.

## Run it

```bash
npm run check   # shows what the bot sees: wallet, pair, phase, fee mode, balances. Sends nothing.
npm run once    # one cycle
npm start       # keep running every intervalMinutes
```

Start with `"dryRun": true`. Every transaction is simulated against the real chain and the result
is printed, so you can see exactly what would happen. Switch to `false` only when the dry runs look
right. Burns and deposits that depend on an earlier step are skipped in dry runs, since nothing was
actually bought.

To keep it running on a server, use something like `pm2 start bot.mjs --name fee-bot` or a systemd
service.

## Notes

- Keep `wallet.json` and `config.json` private. Never commit them; `.gitignore` excludes them.
- pump.fun has a minimum distributable amount for fee-sharing coins. Below it, distribution fails
  harmlessly and the bot retries next cycle.
- On the curve, the buy and the burn are separate transactions, so the burn uses exactly what
  the buy delivered.
- This bot was built against `@pump-fun/pump-sdk` 4.2.0 and `@pump-fun/pump-swap-sdk` 2.2.0 and
  checked offline, but not yet run against live pump.fun programs. Dry-run it first, then try it
  with small amounts.
