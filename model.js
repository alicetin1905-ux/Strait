// Does the Bybit/Crypto.com BTC perp spread survive costs?
// Verifies the arithmetic used by the monitor before it ships.

// Taker fees (public standard tiers; override with your own VIP rates)
const FEE = { bybit: 0.00055, cdc: 0.00050 };

// Crossable-price arithmetic. You BUY at the ask and SELL at the bid.
// Using mids here is the classic way to invent an edge that isn't there.
function legs(bybit, cdc, fee = FEE) {
  // Route A: buy Bybit, sell Crypto.com
  const aIn = bybit.ask * (1 + fee.bybit);
  const aOut = cdc.bid * (1 - fee.cdc);
  const a = (aOut - aIn) / aIn;

  // Route B: buy Crypto.com, sell Bybit
  const bIn = cdc.ask * (1 + fee.cdc);
  const bOut = bybit.bid * (1 - fee.bybit);
  const b = (bOut - bIn) / bIn;

  return { routeA: a, routeB: b, best: Math.max(a, b) };
}

// Gross spread on mids, for comparison
const grossMid = (bybit, cdc) => {
  const mb = (bybit.bid + bybit.ask) / 2, mc = (cdc.bid + cdc.ask) / 2;
  return (mc - mb) / mb;
};

const bps = x => (x * 10000).toFixed(2) + " bps";

let pass = 0, fail = 0;
const t = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n} ${x}`); };

console.log("--- scenario sweep ---\n");

// 1. Typical quiet market: venues within a couple of bps, tight books
const quiet = {
  bybit: { bid: 80870.0, ask: 80870.5 },
  cdc:   { bid: 80878.0, ask: 80882.0 },
};
const q = legs(quiet.bybit, quiet.cdc);
console.log("quiet market");
console.log("  gross mid spread:", bps(grossMid(quiet.bybit, quiet.cdc)));
console.log("  net route A:", bps(q.routeA), "| net route B:", bps(q.routeB));
t("quiet market is unprofitable after fees", q.best < 0, `best ${bps(q.best)}`);

// 2. Dislocation: 0.15% gap, the kind you see in a fast move
const gap = {
  bybit: { bid: 80800.0, ask: 80800.5 },
  cdc:   { bid: 80925.0, ask: 80930.0 },
};
const g = legs(gap.bybit, gap.cdc);
console.log("\n0.15% dislocation");
console.log("  gross mid spread:", bps(grossMid(gap.bybit, gap.cdc)));
console.log("  net route A:", bps(g.routeA), "| net route B:", bps(g.routeB));
t("large dislocation clears fees", g.best > 0, `best ${bps(g.best)}`);

// 3. Breakeven hunt: what gross spread is required?
let need = 0;
for (let s = 0; s < 0.005; s += 0.000005) {
  const px = 80000;
  const b = { bid: px, ask: px + 0.5 };
  const c = { bid: px * (1 + s), ask: px * (1 + s) + 4 };
  if (legs(b, c).best > 0) { need = s; break; }
}
console.log("\nbreakeven gross spread required:", bps(need));
t("breakeven is roughly the fee round trip", need > 0.0009 && need < 0.0016, bps(need));

// 4. USDT/USD basis contaminating the signal.
// Crypto.com is quoted in USD; if USDT trades at 0.9995 USD, the raw
// price gap is partly FX, not a tradable dislocation.
function fxAdjust(cdcPrice, usdtUsd) { return cdcPrice / usdtUsd; }
const usdtUsd = 0.9995;
const rawGap = (80925 - 80800) / 80800;
const adjGap = (fxAdjust(80925, usdtUsd) - 80800) / 80800;
console.log("\nUSDT/USD = 0.9995");
console.log("  raw gap:", bps(rawGap), "-> FX-adjusted:", bps(adjGap));
t("FX adjustment materially moves the signal",
  Math.abs(adjGap - rawGap) > 0.0004, `delta ${bps(adjGap - rawGap)}`);

// 5. Funding differential — the delta-neutral carry version
function fundingEdge(bybitRate, cdcRate, intervalsPerDay = 3) {
  const perInterval = bybitRate - cdcRate;      // long the payer, short the receiver
  return { perInterval, annualized: perInterval * intervalsPerDay * 365 };
}
const f = fundingEdge(0.0001, -0.00005);
console.log("\nfunding differential (0.01% vs -0.005%)");
console.log("  per interval:", bps(f.perInterval), "| annualized:", (f.annualized * 100).toFixed(1) + "%");
t("funding carry is meaningful when rates diverge", f.annualized > 0.10, `${(f.annualized * 100).toFixed(1)}%`);

// 6. But carry must survive entry+exit costs too
const entryCost = (FEE.bybit + FEE.cdc) * 2;
const intervalsToBreakeven = entryCost / f.perInterval;
console.log("  intervals to cover entry+exit:", intervalsToBreakeven.toFixed(1),
  `(~${(intervalsToBreakeven / 3).toFixed(1)} days)`);
t("carry needs a holding period, not a scalp", intervalsToBreakeven > 5);

console.log(`\n${pass} passed, ${fail} failed`);
