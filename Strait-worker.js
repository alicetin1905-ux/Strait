// STRAIT worker — CORS proxy for Bybit, Crypto.com and the USDT/USD rate.
// Public market data only. No API keys, no trade permissions.

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "content-type": "application/json",
};
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: cors });

const BYBIT = "https://api.bybit.com";
const CDC = "https://api.crypto.com/exchange/v1";
const KRAKEN = "https://api.kraken.com";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (url.pathname === "/bybit/ticker") {
        const symbol = url.searchParams.get("symbol") || "BTCUSDT";
        const r = await fetch(`${BYBIT}/v5/market/tickers?category=linear&symbol=${symbol}`);
        return json(await r.json());
      }

      if (url.pathname === "/cdc/ticker") {
        const inst = url.searchParams.get("instrument_name") || "BTCUSD-PERP";

        const tickerReq = fetch(`${CDC}/public/get-tickers?instrument_name=${inst}`)
          .then(r => r.json());

        // Funding lives on a separate endpoint and is not always populated.
        // Treat its absence as missing data, never as zero.
        const fundingReq = fetch(
          `${CDC}/public/get-valuations?instrument_name=${inst}&valuation_type=funding_hist&count=1`
        ).then(r => r.json()).catch(() => null);

        const [ticker, funding] = await Promise.all([tickerReq, fundingReq]);
        if (ticker.code !== 0) return json({ error: ticker.message || "crypto.com rejected the request" }, 502);

        let rate = null;
        const fd = funding && funding.result && funding.result.data;
        if (Array.isArray(fd) && fd.length && fd[0].v != null) rate = Number(fd[0].v);

        return json({ ...ticker, funding: rate });
      }

      if (url.pathname === "/fx/usdt") {
        // USDT priced in USD. Crypto.com settles in USD, Bybit in USDT,
        // so this is the leg that makes the two comparable.
        const r = await fetch(`${KRAKEN}/0/public/Ticker?pair=USDTZUSD`);
        const j = await r.json();
        const k = j.result && Object.keys(j.result)[0];
        const rate = k ? Number(j.result[k].c[0]) : null;
        return json({ rate });
      }

      return json({ error: "unknown route" }, 404);
    } catch (e) {
      return json({ error: e.message }, 502);
    }
  },
};
