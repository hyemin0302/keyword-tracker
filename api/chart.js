/**
 * 차트 프록시 — 기업 페이지 가격 헤더의 기간 토글(5D/1M/6M/1Y)용.
 * Yahoo Finance v8 chart를 서버사이드에서 호출 (브라우저 CORS 우회).
 * 한국 6자리 코드는 .KS → .KQ 순으로 폴백.
 */
export const config = { maxDuration: 30 };

const RANGES = {
  '5d':  { range: '5d',  interval: '30m' },
  '1mo': { range: '1mo', interval: '1d' },
  '6mo': { range: '6mo', interval: '1d' },
  '1y':  { range: '1y',  interval: '1wk' },
};

async function fetchChart(symbol, range, interval) {
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) return null;
  const data = await r.json();
  return data?.chart?.result?.[0] || null;
}

export default async function handler(req, res) {
  try {
    const ticker = String(req.query.symbol || '').trim();
    const rangeKey = String(req.query.range || '1mo');
    if (!/^[A-Za-z0-9.\-^=]{1,12}$/.test(ticker) || !RANGES[rangeKey]) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const { range, interval } = RANGES[rangeKey];
    const isKR = /^\d{6}$/.test(ticker);
    const candidates = isKR ? [`${ticker}.KS`, `${ticker}.KQ`] : [ticker];

    let result = null;
    for (const sym of candidates) {
      result = await fetchChart(sym, range, interval);
      if (result?.meta?.regularMarketPrice) break;
    }
    if (!result) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const rawCloses = result.indicators?.quote?.[0]?.close || [];
    const rawTs = result.timestamp || [];
    const closes = [], dates = [];
    rawCloses.forEach((v, i) => {
      if (v == null) return;
      closes.push(+v.toFixed(4));
      dates.push(rawTs[i] || null);
    });
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=900');
    res.status(200).json({
      symbol: ticker,
      range: rangeKey,
      currency: result.meta?.currency || 'USD',
      px: result.meta?.regularMarketPrice,
      closes,
      dates,
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: 'internal', message: e?.message });
  }
}
