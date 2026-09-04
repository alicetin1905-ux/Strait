// Parser tests for STRAIT's three websocket feeds.
// No network here — mock payloads in the documented wire formats.

// ---- Bybit: snapshot then delta, deltas carry only changed fields ----
function makeBybitState() {
  let s = {};
  return {
    apply(msg) {
      if (!msg.topic || !msg.topic.startsWith("tickers.")) return null;
      s = msg.type === "snapshot" ? { ...msg.data } : { ...s, ...msg.data };
      if (s.bid1Price == null || s.ask1Price == null) return null;
      return {
        bid: +s.bid1Price, ask: +s.ask1Price,
        funding: s.fundingRate != null ? +s.fundingRate : null,
      };
    },
    raw: () => s,
  };
}

// ---- Crypto.com: envelope with result.data, plus heartbeat protocol ----
function parseCdc(msg) {
  if (msg.method === "public/heartbeat") {
    return { heartbeat: { id: msg.id, method: "public/respond-heartbeat" } };
  }
  const r = msg.result;
  if (!r || !Array.isArray(r.data) || !r.data.length) return null;
  const d = r.data[0];
  if (r.channel === "ticker") {
    if (d.b == null || d.k == null) return null;
    return { ticker: { bid: +d.b, ask: +d.k } };
  }
  if (r.channel === "funding" || r.channel === "estimatedfunding") {
    const v = d.v != null ? +d.v : (d.f != null ? +d.f : null);
    return v == null || !isFinite(v) ? null : { funding: v };
  }
  return null;
}

// ---- Coinbase: USDT-USD ticker for the FX leg ----
function parseCoinbase(msg) {
  if (msg.type !== "ticker" || msg.product_id !== "USDT-USD") return null;
  const p = +msg.price;
  return isFinite(p) && p > 0 ? { rate: p } : null;
}

// ---- locale-tolerant number parsing (comma decimal separator) ----
function num(v, fallback = 0) {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v).replace(",", "."));
  return isFinite(n) ? n : fallback;
}

let pass = 0, fail = 0;
const t = (n, c, x = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n} ${x}`); };

// Bybit
const by = makeBybitState();
t("bybit ignores unrelated topic", by.apply({ topic: "orderbook.1.BTCUSDT", data: {} }) === null);
const snap = by.apply({
  topic: "tickers.BTCUSDT", type: "snapshot",
  data: { symbol: "BTCUSDT", bid1Price: "80870.0", ask1Price: "80870.5", fundingRate: "0.0001" },
});
t("bybit snapshot parsed", snap && snap.bid === 80870 && snap.ask === 80870.5, JSON.stringify(snap));
const delta = by.apply({ topic: "tickers.BTCUSDT", type: "delta", data: { ask1Price: "80871.5" } });
t("bybit delta merges, keeps bid", delta && delta.bid === 80870 && delta.ask === 80871.5, JSON.stringify(delta));
t("bybit delta preserves funding", delta.funding === 0.0001, `${delta.funding}`);

// Crypto.com
const hb = parseCdc({ id: 1587523073344, method: "public/heartbeat", code: 0 });
t("cdc heartbeat produces matching reply",
  hb.heartbeat.id === 1587523073344 && hb.heartbeat.method === "public/respond-heartbeat");
const cdcTick = parseCdc({
  id: -1, method: "subscribe", code: 0,
  result: { instrument_name: "BTCUSD-PERP", subscription: "ticker.BTCUSD-PERP", channel: "ticker",
    data: [{ h: "81000", l: "80000", a: "80880", b: "80878.0", k: "80882.0", t: 1 }] },
});
t("cdc ticker parsed", cdcTick.ticker.bid === 80878 && cdcTick.ticker.ask === 80882, JSON.stringify(cdcTick));
const cdcFund = parseCdc({
  result: { channel: "funding", subscription: "funding.BTCUSD-PERP", data: [{ v: "-0.00005", t: 1 }] },
});
t("cdc funding parsed", cdcFund.funding === -0.00005, `${cdcFund.funding}`);
t("cdc empty data rejected", parseCdc({ result: { channel: "ticker", data: [] } }) === null);
t("cdc subscribe ack ignored", parseCdc({ id: 1, method: "subscribe", code: 0 }) === null);
t("cdc missing funding not coerced to zero",
  parseCdc({ result: { channel: "funding", data: [{ t: 1 }] } }) === null);

// Coinbase
t("coinbase ticker parsed",
  parseCoinbase({ type: "ticker", product_id: "USDT-USD", price: "0.9995" }).rate === 0.9995);
t("coinbase subscriptions msg ignored",
  parseCoinbase({ type: "subscriptions", channels: [] }) === null);
t("coinbase wrong product ignored",
  parseCoinbase({ type: "ticker", product_id: "BTC-USD", price: "80000" }) === null);

// locale
t("comma decimal parsed", num("0,055") === 0.055, `${num("0,055")}`);
t("dot decimal parsed", num("0.055") === 0.055);
t("empty falls back", num("") === 0);
t("garbage falls back", num("abc", 0) === 0);

// end-to-end edge arithmetic with FX applied
function routes(b, c, fb, fc) {
  const aIn = b.ask * (1 + fb), aOut = c.bid * (1 - fc);
  const bIn = c.ask * (1 + fc), bOut = b.bid * (1 - fb);
  return { A: (aOut - aIn) / aIn, B: (bOut - bIn) / bIn };
}
const fx = 0.9995;
const cdUsdt = { bid: 80878 / fx, ask: 80882 / fx };
const r = routes({ bid: 80870, ask: 80870.5 }, cdUsdt, num("0,055") / 100, num("0,050") / 100);
console.log(`\nFX-adjusted net: A ${(r.A * 10000).toFixed(2)} bps | B ${(r.B * 10000).toFixed(2)} bps`);
t("quiet market still unprofitable after FX adjust", Math.max(r.A, r.B) < 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
