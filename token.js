// GET /api/token
// Supply, authorities, bonding curve progress, migration status and labelled top holders.
import { PublicKey } from "@solana/web3.js";
import { env, rpc, migration, send, fail, requireEnv, PUMP } from "./_lib.js";

const INITIAL_REAL_TOKEN_RESERVES = 793_100_000; // tokens sold along a pump.fun curve before it completes

export default async function handler(req, res) {
  if (!requireEnv(res, "helius", "mint")) return;
  try {
    const mint = new PublicKey(env.mint);
    const [curvePda] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], new PublicKey(PUMP));

    const [mintAcc, largest, curveAcc, mig] = await Promise.all([
      rpc("getAccountInfo", [env.mint, { encoding: "jsonParsed" }]),
      rpc("getTokenLargestAccounts", [env.mint]).catch(() => ({ value: [] })),
      rpc("getAccountInfo", [curvePda.toBase58(), { encoding: "base64" }]).catch(() => null),
      migration(),
    ]);

    const info = mintAcc?.value?.data?.parsed?.info;
    if (!info) throw new Error("Mint account not found. Check TOKEN_MINT.");
    const decimals = info.decimals;
    const supply = Number(info.supply) / 10 ** decimals;

    // Bonding curve account layout: 8-byte discriminator, then u64 virtualToken, virtualSol,
    // realToken, realSol, tokenTotalSupply, then a bool "complete".
    let curve = null;
    const cv = curveAcc?.value;
    if (cv && cv.owner === PUMP) {
      const buf = Buffer.from(cv.data[0], "base64");
      const realToken = Number(buf.readBigUInt64LE(24)) / 10 ** decimals;
      const realSol = Number(buf.readBigUInt64LE(32)) / 1e9;
      const complete = buf[48] === 1;
      curve = {
        address: curvePda.toBase58(),
        complete,
        progress: complete ? 1 : Math.min(1, Math.max(0, 1 - realToken / INITIAL_REAL_TOKEN_RESERVES)),
        realSol,
        realToken,
      };
    }

    // Look up who owns each of the top token accounts, so we can label the curve, pool and buyback wallet.
    const top = largest?.value || [];
    let owners = [];
    if (top.length) {
      const multi = await rpc("getMultipleAccounts", [top.map(t => t.address), { encoding: "jsonParsed" }]).catch(() => null);
      owners = (multi?.value || []).map(a => a?.data?.parsed?.info?.owner || null);
    }
    const label = owner => {
      if (!owner) return null;
      if (owner === curvePda.toBase58()) return "bonding curve";
      if (mig.ammPool && owner === mig.ammPool) return "PumpSwap pool";
      if (env.wallet && owner === env.wallet) return "buyback wallet";
      return null;
    };
    const holders = top.map((t, i) => ({ account: t.address, owner: owners[i], amount: t.uiAmount, label: label(owners[i]) }));

    send(res, {
      mint: env.mint,
      wallet: env.wallet || null,
      decimals,
      supply,
      mintAuthority: info.mintAuthority || null,
      freezeAuthority: info.freezeAuthority || null,
      curve,
      migration: { ...mig, migrated: mig.migrated || !!curve?.complete },
      holders,
    }, 15);
  } catch (e) {
    fail(res, e);
  }
}
