/**
 * 키워드 에이전트 — RSS 수집 + LLM 분석으로 키워드별 뉴스·이벤트 자동 생성
 * Groq Llama 3.1 8B (fast/cheap) + 3.3 70B (insight)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── RSS 피드 (한국 + 글로벌) ───────────────────────────────
const FEEDS = [
  { url: 'https://www.yna.co.kr/rss/economy.xml',                         src: '연합뉴스' },
  { url: 'https://www.hankyung.com/feed/all-news',                        src: '한국경제' },
  { url: 'https://www.hankyung.com/feed/economy',                         src: '한경 경제' },
  { url: 'https://www.hankyung.com/feed/it',                              src: '한경 IT' },
  { url: 'https://www.mk.co.kr/rss/30000001/',                            src: '매일경제' },
  { url: 'https://rss.donga.com/total.xml',                               src: '동아일보' },
  { url: 'https://www.chosun.com/arc/outboundfeeds/rss/?outputType=xml',  src: '조선일보' },
  { url: 'https://www.newsis.com/rss/realnews.xml',                       src: '뉴시스'   },
  { url: 'https://www.hani.co.kr/rss/economy',                            src: '한겨레'   },
  { url: 'https://rss.etnews.com/Section902.xml',                         src: '전자신문' },
  { url: 'https://blogs.nvidia.com/feed/',                                src: 'NVIDIA공식' },
  { url: 'https://news.samsung.com/kr/feed',                              src: '삼성뉴스룸' },
  { url: 'https://feeds.nbcnews.com/nbcnews/public/tech',                 src: 'CNBC Tech' },
  { url: 'https://www.theverge.com/rss/index.xml',                        src: 'The Verge' },
  { url: 'https://techcrunch.com/feed/',                                  src: 'TechCrunch' },
  { url: 'https://feeds.bloomberg.com/technology/news.rss',              src: 'Bloomberg Tech' },
];

// ── Cerebras AI 헬퍼 (OpenAI 호환, 무료·고속·카드 불필요) ────
// 무료 한도: 30 RPM, 14,400 RPD. Llama 3.3 70B / 3.1 8B 무료.
async function callCerebras(model, messages, maxTokens = 512, jsonMode = true) {
  const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.CEREBRAS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`Cerebras ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message.content;
}

// ── Together AI 헬퍼 (OpenAI 호환, 별도 organization → TPM 풀 독립) ─
// 무료 모델: meta-llama/Llama-3.3-70B-Instruct-Turbo-Free (60 RPM, 1k RPD)
async function callTogether(model, messages, maxTokens = 512, jsonMode = true) {
  const res = await fetch('https://api.together.xyz/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.TOGETHER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(40000),
  });
  if (!res.ok) throw new Error(`Together ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message.content;
}

// ── Groq API 헬퍼 ──────────────────────────────────────────
async function callGroq(model, messages, maxTokens = 512, jsonMode = true) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(35000),
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message.content;
}

// ── HTML → 텍스트 ─────────────────────────────────────────
function htmlToText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g,'  ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/\s+/g, ' ').trim();
}

function extractBody(html) {
  for (const re of [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<body[^>]*>([\s\S]*?)<\/body>/i,
  ]) {
    const m = html.match(re);
    if (m?.[1]?.length > 200) return htmlToText(m[1]).slice(0, 2000);
  }
  return htmlToText(html).slice(0, 2000);
}

async function fetchFullText(url) {
  if (!url) return '';
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return '';
    return extractBody(await r.text());
  } catch { return ''; }
}

// ── RSS 파싱 ──────────────────────────────────────────────
function extractTag(xml, tag) {
  const cdataRe = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i');
  const plainRe  = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');
  return (xml.match(cdataRe) || xml.match(plainRe) || [])[1]?.trim() || '';
}

// ── Google News RSS 전용 파서 ─────────────────────────────
// title 끝의 " - 매체명"을 출처로 추출. description은 비어있음.
function parseGoogleRSS(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    let title = extractTag(b, 'title');
    const link = extractTag(b, 'link') || extractTag(b, 'guid');
    const date = extractTag(b, 'pubDate');
    const sourceTag = extractTag(b, 'source');
    let src = sourceTag || 'Google';
    const m2 = title.match(/^(.*) - ([^-]+)$/);
    if (m2) { title = m2[1].trim(); if (!sourceTag) src = m2[2].trim(); }
    if (!title) continue;
    if (isNoisyTitle(title)) continue; // 스포츠/엔터 노이즈 차단
    items.push({
      s: src,
      t: title,
      d: '',
      u: link,
      m: date ? new Date(date).toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '',
      ts: date ? new Date(date).getTime() : 0,
    });
  }
  return items;
}

// 별칭별로 Google News 키워드 검색. 너무 많이 호출하지 않도록 상위 3개만.
async function fetchGoogleNewsForAliases(aliases) {
  const top = aliases.slice(0, 3);
  const all = [];
  await Promise.allSettled(top.map(async (kw) => {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(kw)}&hl=ko&gl=KR&ceid=KR:ko`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      const items = parseGoogleRSS(await r.text());
      all.push(...items.slice(0, 30)); // 별칭당 최대 30건만
    } catch {}
  }));
  return all;
}

// ── 비즈니스 외 노이즈 필터 (제목 기준) ─────────────────
// 삼성화재→배구단, 삼성라이온즈→야구, 현대차→축구단 등 종목명 = 구단명 케이스 차단
const NOISE_TITLE_KEYWORDS = [
  // 스포츠
  '경기','승리','패배','출전','선수','감독','구단','코치','MVP','VNL','월드컵','올림픽','챔피언십','챔피언스','리그','시즌','결승','준결승','플레이오프','우승','연패','연승','득점',
  '배구','축구','야구','농구','골프','테니스','수영','육상','블루팡스','라이온즈','자이언츠','다이노스','히어로즈','베어스','이글스','위즈','윙즈','블루스타스',
  // 엔터·연예
  '아이돌','걸그룹','보이그룹','콘서트','앨범','드라마','영화','출연','배우','가수','뮤지컬','팬미팅','팬사인회','컴백','데뷔','뮤직비디오','MV',
  // 공익 (기업 광고성, 투자 의사결정과 무관)
  '안내견','봉사활동','기부','자선','후원금','캠페인','어버이날','크리스마스','어린이날',
];
function isNoisyTitle(title) {
  if (!title) return false;
  for (const k of NOISE_TITLE_KEYWORDS) {
    if (title.includes(k)) return true;
  }
  return false;
}

function parseRSS(xml, src, lowerKeywords) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const title = extractTag(b, 'title');
    const link  = extractTag(b, 'link') || extractTag(b, 'guid');
    const desc  = extractTag(b, 'description').replace(/<[^>]+>/g, '').slice(0, 400);
    const date  = extractTag(b, 'pubDate');
    if (!title) continue;
    if (isNoisyTitle(title)) continue; // 스포츠/엔터/공익 노이즈 차단
    const lowerText = (title + ' ' + desc).toLowerCase();
    if (!lowerKeywords.some(kw => lowerText.includes(kw))) continue;
    items.push({
      s: src, t: title, d: desc, u: link,
      m: date ? new Date(date).toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '',
      ts: date ? new Date(date).getTime() : 0,
    });
  }
  return items;
}

// ── 키워드 별칭 생성 ──────────────────────────────────────
// index.json의 각 키워드 항목에 정의된 aliases 필드를 우선 사용.
// 기본 매칭 키: slug, name.ko, name.en + aliases.
function buildKeywordAliases(keywordConfig) {
  const { slug, name = {}, aliases = [] } = keywordConfig;
  const base = [slug, name.ko, name.en].filter(Boolean);
  return [...new Set([...base, ...aliases])];
}

// ── ticker → 표시 이름 매핑 ───────────────────────────────
let _tickerNameCache = null;
function loadTickerNames() {
  if (_tickerNameCache) return _tickerNameCache;
  try {
    const p = path.join(ROOT, 'public/data/tickers.json');
    const t = JSON.parse(fs.readFileSync(p, 'utf8'));
    _tickerNameCache = { ...(t.kr || {}), ...(t.us || {}) };
  } catch { _tickerNameCache = {}; }
  return _tickerNameCache;
}

// ── 주가 조회 (Yahoo Finance) ─────────────────────────────
// 한국 주식 6자리 코드는 .KS(코스피) → .KQ(코스닥) 순으로 폴백.
// range=1mo로 호출하면 한 응답에 메타 + 30일 종가가 함께 옴 → sparkline용.
async function fetchYahoo(symbol, range = '1mo', interval = '1d') {
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`,
    { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000) }
  );
  if (!r.ok) return null;
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) return null;
  // closes와 dates를 같이 필터링해 인덱스 정합 유지 (발언-주가 반응 계산용)
  const rawCloses = result.indicators?.quote?.[0]?.close || [];
  const rawTs = result.timestamp || [];
  const closes = [], dates = [];
  rawCloses.forEach((v, i) => {
    if (v == null) return;
    closes.push(v);
    dates.push(rawTs[i] ? new Date(rawTs[i] * 1000).toISOString().slice(0, 10) : null);
  });
  return { meta: result.meta, closes, dates };
}

// ── 애널리스트 컨센서스 (Yahoo quoteSummary, crumb 우회) ───
// fc.yahoo.com이 404를 주면서 세션 쿠키를 내려주는 것을 이용해 crumb 발급.
// 막히면 null 반환 → 프론트는 목표주가 게이지를 숨김 (우아한 강등).
let _yahooAuth = null;
async function getYahooAuth() {
  if (_yahooAuth) return _yahooAuth;
  try {
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'manual', signal: AbortSignal.timeout(7000),
    });
    const cookie = (r1.headers.get('set-cookie') || '').split(';')[0];
    if (!cookie) return null;
    const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookie }, signal: AbortSignal.timeout(7000),
    });
    if (!r2.ok) return null;
    const crumb = (await r2.text()).trim();
    if (!crumb || crumb.includes('<')) return null;
    _yahooAuth = { cookie, crumb };
    return _yahooAuth;
  } catch { return null; }
}

async function fetchYahooConsensus(symbol) {
  try {
    const auth = await getYahooAuth();
    if (!auth) return null;
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`
      + `?modules=financialData,calendarEvents&crumb=${encodeURIComponent(auth.crumb)}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': auth.cookie }, signal: AbortSignal.timeout(7000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const res = d?.quoteSummary?.result?.[0];
    if (!res) return null;
    const fd = res.financialData || {};
    const ce = res.calendarEvents || {};
    const earnings = ce.earnings?.earningsDate?.[0];
    const out = {
      targetMean: fd.targetMeanPrice?.raw ?? null,
      targetHigh: fd.targetHighPrice?.raw ?? null,
      targetLow:  fd.targetLowPrice?.raw ?? null,
      analysts:   fd.numberOfAnalystOpinions?.raw ?? null,
      recommendation: fd.recommendationKey || null,
      earningsDate: earnings?.fmt || (earnings?.raw ? new Date(earnings.raw * 1000).toISOString().slice(0, 10) : null),
      source: 'yahoo',
    };
    return (out.targetMean || out.earningsDate) ? out : null;
  } catch { return null; }
}

// ── 펀더멘털 조회 ─────────────────────────────────────────
// 한국: 네이버 m.stock /integration (PER·PBR·시총·외국인보유율·배당·52주 등 한 번에)
// 미국: Yahoo가 인증 도입으로 막힘 → chart meta의 52주 고저·거래량만
async function fetchValuationKR(code) {
  try {
    const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/integration`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const d = await r.json();
    const map = {};
    for (const it of d.totalInfos || []) map[it.code] = it.value;
    return {
      marketCap: map.marketValue,
      per: map.per,
      pbr: map.pbr,
      cnsPer: map.cnsPer,
      divYield: map.dividendYieldRatio,
      foreignRatio: map.foreignRate,
      high52w: map.highPriceOf52Weeks,
      low52w: map.lowPriceOf52Weeks,
      consensus: extractNaverConsensus(d, map),
    };
  } catch { return null; }
}

// 네이버 integration 응답에서 목표주가 컨센서스 추출.
// 응답 스키마가 변동될 수 있어 알려진 필드 후보를 순서대로 탐색하고 없으면 null.
function extractNaverConsensus(d, totalMap) {
  const toNum = (v) => {
    if (v == null) return null;
    const n = parseFloat(String(v).replace(/[,원\s]/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const c = d.consensusInfo || d.consensus || d.researchConsensus || {};
  const targetMean = toNum(c.priceTargetMean) ?? toNum(c.targetPrice) ?? toNum(c.priceTarget)
    ?? toNum(totalMap.cnsTargetPrice) ?? toNum(totalMap.targetPrice);
  if (!targetMean) return null;
  return {
    targetMean,
    targetHigh: toNum(c.priceTargetMax) ?? toNum(c.targetPriceMax) ?? null,
    targetLow:  toNum(c.priceTargetMin) ?? toNum(c.targetPriceMin) ?? null,
    analysts:   toNum(c.analystCount) ?? toNum(c.researchCount) ?? null,
    recommendation: c.recommMean || c.recommendation || null,
    earningsDate: null,
    source: 'naver',
  };
}

function valuationFromMeta(meta) {
  if (!meta) return null;
  return {
    high52w: meta.fiftyTwoWeekHigh,
    low52w: meta.fiftyTwoWeekLow,
    volume: meta.regularMarketVolume,
  };
}

// ── 매크로 지표 (PB 컨텍스트) ────────────────────────────
// USD/KRW · KOSPI · S&P · VIX · 미10년물 · WTI 한 번에 fetch
const MACRO_SYMBOLS = [
  { sym: 'KRW=X', short: 'USD/KRW',  category: '환율',   format: 'price' },
  { sym: '^KS11', short: 'KOSPI',    category: '한국증시', format: 'price' },
  { sym: '^GSPC', short: 'S&P500',   category: '미증시',  format: 'price' },
  { sym: '^IXIC', short: '나스닥',    category: '미증시',  format: 'price' },
  { sym: '^VIX',  short: 'VIX',      category: '변동성',   format: 'price' },
  { sym: '^TNX',  short: '美10년물', category: '금리',   format: 'pct' },
  { sym: 'CL=F',  short: 'WTI',      category: '원자재',  format: 'price' },
  { sym: 'GC=F',  short: '금',        category: '원자재',  format: 'price' },
];

export async function fetchMacro() {
  const results = await Promise.allSettled(MACRO_SYMBOLS.map(async (m) => {
    try {
      const payload = await fetchYahoo(m.sym);
      const meta = payload?.meta;
      if (!meta?.regularMarketPrice) return null;
      const closes = (payload.closes || []).map(v => +v.toFixed(2));
      // 어제 종가 대비 변화율 (Yahoo의 regularMarketChangePercent가 빈 케이스 많음 → 직접 계산)
      const prev = closes.length >= 2 ? closes[closes.length - 2] : meta.chartPreviousClose;
      const px = meta.regularMarketPrice;
      const change = prev ? +(((px - prev) / prev) * 100).toFixed(2) : 0;
      // 5일 전 대비
      const fiveBack = closes.length >= 5 ? closes[closes.length - 5] : null;
      const change5d = fiveBack ? +(((px - fiveBack) / fiveBack) * 100).toFixed(2) : null;
      return {
        symbol: m.sym,
        short: m.short,
        category: m.category,
        format: m.format,
        px,
        change,
        change5d,
        prices: closes.slice(-21), // 약 1개월 sparkline
      };
    } catch { return null; }
  }));
  return results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
}

// ── 한국 종목 외국인·기관 일별 순매수 (10일치) ──────────
async function fetchInvestorFlow(code) {
  try {
    const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/trend`,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    const toNum = (s) => parseInt(String(s || '0').replace(/[,+\s]/g, ''), 10) || 0;
    const items = arr.slice(0, 10).map(d => ({
      date: d.bizdate,
      foreigner: toNum(d.foreignerPureBuyQuant),
      institution: toNum(d.organPureBuyQuant),
      individual: toNum(d.individualPureBuyQuant),
      foreignRatio: d.foreignerHoldRatio,
    }));
    // 5거래일 / 10거래일 누적
    const sum5For = items.slice(0, 5).reduce((a, b) => a + b.foreigner, 0);
    const sum5Inst = items.slice(0, 5).reduce((a, b) => a + b.institution, 0);
    const sum10For = items.reduce((a, b) => a + b.foreigner, 0);
    const sum10Inst = items.reduce((a, b) => a + b.institution, 0);
    return {
      items,
      sum5d: { foreigner: sum5For, institution: sum5Inst },
      sum10d: { foreigner: sum10For, institution: sum10Inst },
    };
  } catch { return null; }
}

// ── 벤치마크 (KOSPI / S&P500) 30일 종가 ───────────────────
export async function fetchBenchmarks() {
  const fetchOne = async (sym) => {
    try {
      const p = await fetchYahoo(sym);
      return p?.closes || [];
    } catch { return []; }
  };
  const [kospi, sp500] = await Promise.all([fetchOne('^KS11'), fetchOne('^GSPC')]);
  return { kospi, sp500 };
}

// ── 테마 지수 (등가중 누적 변화율, %) ─────────────────────
function computeThemeIndex(stockData) {
  const series = Object.values(stockData).map(s => s.prices).filter(p => p && p.length >= 2);
  if (!series.length) return [];
  const len = Math.min(...series.map(s => s.length));
  const out = [];
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (const s of series) sum += (s[i] - s[0]) / s[0];
    out.push(+(sum / series.length * 100).toFixed(2));
  }
  return out;
}

// 벤치마크를 테마와 같은 길이로 정규화(시작=0%, 일별 누적변화율)
function normalize(closes, len) {
  if (!closes?.length) return [];
  const slice = closes.slice(-len);
  const base = slice[0];
  if (!base) return [];
  return slice.map(c => +((c - base) / base * 100).toFixed(2));
}

async function fetchStockPrices(tickers, opts = {}) {
  const { consensusFor = [] } = opts; // 컨센서스(목표주가·실적일)까지 가져올 ticker 목록
  const nameMap = loadTickerNames();
  const results = {};
  await Promise.allSettled(tickers.map(async ticker => {
    try {
      const isKR = /^\d{6}$/.test(ticker);
      const candidates = isKR ? [`${ticker}.KS`, `${ticker}.KQ`] : [ticker];
      let payload = null;
      for (const sym of candidates) {
        payload = await fetchYahoo(sym);
        if (payload?.meta?.regularMarketPrice) break;
      }
      const meta = payload?.meta;
      if (meta?.regularMarketPrice) {
        const fallbackName = (meta.shortName && !/^\d/.test(meta.shortName)) ? meta.shortName : ticker;
        const closes = (payload.closes || []).map(v => +v.toFixed(2));
        const periodChange = closes.length >= 2
          ? +(((closes[closes.length - 1] - closes[0]) / closes[0]) * 100).toFixed(2)
          : 0;
        // Yahoo가 regularMarketChangePercent를 빈 값으로 주는 케이스 多 → 전일 종가로 직접 계산 (fetchMacro와 동일 방식)
        let dayChange = +(meta.regularMarketChangePercent || 0).toFixed(2);
        if (!dayChange && closes.length >= 2) {
          const prevClose = closes[closes.length - 2];
          if (prevClose) dayChange = +(((meta.regularMarketPrice - prevClose) / prevClose) * 100).toFixed(2);
        }
        const wantConsensus = consensusFor.includes(ticker);
        // 펀더멘털: 한국은 네이버, 미국은 chart meta에서 추출 가능한 항목만
        // 한국 종목은 외국인·기관 일별 순매수도 같이 fetch
        const [fundamentals, investorFlow, usConsensus] = await Promise.all([
          isKR ? fetchValuationKR(ticker) : Promise.resolve(valuationFromMeta(meta)),
          isKR ? fetchInvestorFlow(ticker) : Promise.resolve(null),
          (!isKR && wantConsensus) ? fetchYahooConsensus(ticker) : Promise.resolve(null),
        ]);
        // 컨센서스: 미국=Yahoo quoteSummary, 한국=네이버 integration에서 추출된 값
        const consensus = wantConsensus
          ? (isKR ? (fundamentals?.consensus || null) : usConsensus)
          : null;
        results[ticker] = {
          name: nameMap[ticker] || fallbackName,
          px: meta.regularMarketPrice,
          dayChange,
          periodChange,
          prices: closes,
          dates: payload.dates || [],
          volume: meta.regularMarketVolume,
          currency: meta.currency || 'USD',
          state: meta.marketState || 'CLOSED',
          market: isKR ? 'KR' : 'US',
          fundamentals,
          investorFlow,
          consensus,
        };
      }
    } catch {}
  }));
  return results;
}

// ── 변동성 기반 시나리오 가격 밴드 (기업 키워드 전용) ──────
// LLM에게 목표가 숫자를 만들게 하지 않는다 (환각 위험).
// 대신 최근 일별 수익률의 실현 변동성으로 ±1σ 통계 밴드를 계산하고,
// 애널리스트 목표주가(실데이터)를 별도 라인으로 겹쳐 보여준다.
function computeProjection(closes, px) {
  if (!Array.isArray(closes) || closes.length < 10 || !px) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 8) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(variance);
  if (!Number.isFinite(sd) || sd <= 0) return null;
  const horizons = [
    { days: 5,  label: '1주' },
    { days: 21, label: '1개월' },
    { days: 63, label: '3개월' },
  ];
  return {
    asOf: new Date().toISOString().slice(0, 10),
    base: px,
    volAnnualPct: +(sd * Math.sqrt(252) * 100).toFixed(1),
    horizons: horizons.map(h => ({
      days: h.days,
      label: h.label,
      bull: +(px * Math.exp(sd * Math.sqrt(h.days))).toFixed(2),
      bear: +(px * Math.exp(-sd * Math.sqrt(h.days))).toFixed(2),
    })),
  };
}

// ── LLM 인사이트 생성 (키워드 타입별 분기) ────────────────
// type: 'person'(인물) | 'company'(기업) | 'sector'(산업 테마, 기본값)
async function generateInsight(slug, nameKo, articles, stockData, type = 'sector', keywordConfig = null) {
  if (!process.env.GROQ_API_KEY || !articles.length) return null;
  const top5 = articles.slice(0, 5).map((a, i) => `[${i+1}] ${a.s}: ${a.t} — ${a.d?.slice(0,100)}`).join('\n');
  const stockSummary = Object.entries(stockData).slice(0, 6)
    .map(([code, s]) => `${s.name || code}(${code}): ${s.currency === 'KRW' ? '₩' : '$'}${s.px}`).join(', ');
  const today = new Date().toISOString().slice(0, 10);

  // 기업 키워드: 애널리스트 목표주가는 *실데이터*이므로 프롬프트에 주입해 인용 허용
  let factsBlock = '';
  if (type === 'company' && keywordConfig?.primaryTicker) {
    const p = stockData[keywordConfig.primaryTicker];
    if (p?.consensus?.targetMean) {
      const cur = p.currency === 'KRW' ? '원' : '달러';
      factsBlock = `\n검증된 시장 데이터 (인용 가능):\n- ${p.name} 애널리스트 평균 목표주가: ${p.consensus.targetMean}${cur}`
        + (p.consensus.analysts ? ` (애널리스트 ${p.consensus.analysts}명)` : '')
        + (p.consensus.earningsDate ? `\n- 다음 실적 발표 예정일: ${p.consensus.earningsDate}` : '') + '\n';
    }
  }

  // ── 타입별 분석 관점 + 추가 스키마 필드 ──
  const subjectLabel = type === 'person' ? '인물' : type === 'company' ? '기업(단일 종목)' : '투자 테마';
  const typeFocus = {
    person: `이 키워드는 *인물*이다. 분석의 중심은 "이 인물의 발언·행보가 어떤 종목을 어떻게 움직이는가"이다.
- summary와 outlook은 인물의 최근 발언/행보가 시장·관련 종목에 주는 신호 중심으로 작성.
- 인물 자체의 평판이 아니라 *투자 시그널*로서의 의미에 집중.`,
    company: `이 키워드는 *단일 상장기업*이다. PB가 "고객이 이 종목을 물어보면 뭐라고 답할까"에 바로 쓸 분석이어야 한다.
- summary와 outlook은 이 기업 한 종목의 주가 관점으로 작성. 경쟁사는 비교 맥락으로만.
- pb_perspective의 talking_point 2개는 고객에게 그대로 읽어줄 수 있는 완성형 문장으로.`,
    sector: `이 키워드는 *산업 테마*다. 개별 종목보다 밸류체인·정책·수급 등 산업 전체 구도를 분석하라.`,
  }[type];

  const typeSchema = {
    person: `,
  "profile": {
    "role": "이 인물의 현재 직책·소속 1문장 (뉴스 기반)",
    "why_matters": "왜 시장이 이 인물을 주목하는가 1~2문장"
  },
  "statements": [
    { "date": "YYYY-MM-DD 또는 null", "statement": "발언/행보 요약 1문장", "context": "어디서 (행사·인터뷰·매체)", "signal": "positive|negative|neutral", "tickers": ["영향 받는 ticker (제공된 관련 종목 코드만)"] }
  ]`,
    company: ``,
    sector: `,
  "value_chain": {
    "upstream": ["소재·장비·부품 단 ticker (아래 관련 종목 코드 중에서만 선택)"],
    "midstream": ["제조·생산 단 ticker"],
    "downstream": ["응용·서비스·수요 단 ticker"]
  },
  "policy_tracker": [
    { "date": "YYYY-MM-DD 또는 null", "title": "정책·규제·보조금 뉴스 요약 1문장", "region": "KR|US|EU|CN|글로벌", "stance": "supportive|restrictive|neutral" }
  ]`,
  }[type];

  const typeRules = {
    person: `- statements는 뉴스 원문에 실제 등장한 발언·행보만. 최대 6개. 날짜가 명시 안 됐으면 null.
- statements[].tickers는 제공된 관련 종목 코드 중에서만 선택.`,
    company: `- pb_perspective의 talking_point_holders / talking_point_prospects는 반드시 채울 것. PB가 고객에게 그대로 읽어줄 완성형 문장으로.`,
    sector: `- value_chain은 반드시 채울 것. 다음 종목 코드를 빠짐없이 upstream/midstream/downstream 중 하나로 분류하라 (새 종목 추가 금지, 애매하면 midstream): ${Object.keys(stockData).join(', ') || '없음'}
- policy_tracker는 뉴스 원문에 등장한 정책·규제·보조금만. 없으면 빈 배열. 최대 5개.`,
  }[type];

  const prompt = `${subjectLabel} "${nameKo}" 관련 뉴스·주가를 분석해 한국어 JSON으로 반환해줘. 오늘은 ${today}.

${typeFocus}

뉴스:
${top5}

관련 종목: ${stockSummary || '데이터 없음'}
${factsBlock}
JSON 스키마:
{
  "summary": "핵심 동향 2~3문장",
  "sentiment": "bullish|bearish|neutral",
  "key_drivers": ["주요 동력 2~4개"],
  "watch_points": ["관전 포인트 2~4개"],
  "risks": ["주요 리스크 1~3개. 하방 요인"],
  "events": [
    { "date": "YYYY-MM-DD 또는 YYYY-Qn 또는 'TBD'", "title": "예정 이벤트(실적/제품/상장/규제 등)", "impact": "positive|negative|neutral" }
  ],
  "key_players": ["테마를 주도하는 기업·인물 2~5개. 한글 표기 우선"],
  "outlook": {
    "short_term": {
      "thesis":   "단기(1~2주) 분석. 다음 1~2주 내 임박한 캐털리스트(예정 발표/계약/규제 결정 등)와 단기 수급/모멘텀에 초점. 4~6문장.",
      "upside":   "상방 시나리오 1~2문장. 어떤 조건이면 강해지는가.",
      "downside": "하방 시나리오 1~2문장. 어떤 조건이면 약해지는가."
    },
    "mid_term": {
      "thesis":   "중기(1~3개월) 분석. 다음 분기 실적 추정, 정책/규제 변화, 경쟁구도 재편에 초점. 단기 thesis와 절대 같은 내용 쓰지 말 것. 4~6문장.",
      "upside":   "상방 시나리오 1~2문장.",
      "downside": "하방 시나리오 1~2문장."
    },
    "long_term": {
      "thesis":   "장기(6~12개월) 분석. 산업의 구조적 트렌드, 시장 점유율 변화, 진입장벽·기술 격차 같은 펀더멘털에 초점. 단기/중기 thesis와 절대 같은 내용 쓰지 말 것. 4~6문장.",
      "upside":   "상방 시나리오 1~2문장.",
      "downside": "하방 시나리오 1~2문장."
    }
  },
  "capital_flow": {
    "summary": "자금 흐름 1~2문장 요약(외국인·기관 순매수, ETF 자금 유입, IPO 청약, 펀드 자금 등)",
    "signals": ["뉴스에서 추출된 구체 시그널 2~4개. 예: '미래에셋 스페이스X 2차 청약 완판', '한투운용 우주테크 ETF 600억 순매수'"]
  },
  "scenarios": [
    {"case":"기본(Base)","probability":60,"thesis":"2~3문장","trigger":"*측정 가능 임계값*. 예: '외인 5일 +300K주', 'PER 25배 돌파', 'FOMC 25bp 인상'. 모호한 표현 금지.","watch_period":"1~2주/분기"},
    {"case":"강세(Bull)","probability":20,"thesis":"2~3문장","trigger":"강세 트리거 (다른 시나리오와 중복 금지)","watch_period":"기간"},
    {"case":"약세(Bear)","probability":20,"thesis":"2~3문장","trigger":"약세 트리거 (다른 시나리오와 중복 금지)","watch_period":"기간"}
  ],
  "pb_perspective": {
    "valuation_assessment": "PER/PBR + 동종업계/과거 대비 평가 2~3문장",
    "momentum_signals": "외인/기관 수급·모멘텀·신고가 근접 2~3문장",
    "fundamental_strength": "성장·마진·재무 안정성 2~3문장",
    "key_monitors": ["매주 모니터할 지표·일정 3~4개"],
    "position_sizing_view": "Core/Satellite/Trade 중 어느 성격 + 근거 1~2문장"${type === 'company' ? `,
    "talking_point_holders": "이미 보유 중인 고객에게 할 말 2~3문장 (들고 갈지/덜어낼지 관점)",
    "talking_point_prospects": "신규 문의 고객에게 할 말 2~3문장 (지금 들어가도 되는지 관점)"` : ''}
  }${typeSchema},
  "disclaimer": "본 분석은 AI 생성 정보이며 투자 권유가 아닙니다."
}

절대 규칙:
- 모든 텍스트는 순 한국어. 한자(延期 등) 금지. 불가피하면 괄호 병기.
- 모든 분석은 위에 제공된 뉴스에 *명시적으로 등장한 사실*만 사용. 등장하지 않은 기업명·수치·이벤트는 절대 추가하지 말 것. 모르면 "관련 뉴스 없음"이라 솔직히 적기.
- scenarios의 probability 합은 정확히 100이어야 함. 정수만 사용.
- scenarios의 3개 trigger는 *서로 완전히 다른 변수*여야 함. 모두 같은 "실적 발표" 금지.
- pb_perspective는 PB 의사결정에 직접 쓰는 정보. 일반론 금지, 이 종목/테마 *특정* 분석만.

수치 인용 절대 규칙 (가장 중요 - 환각 방지):
- 뉴스에 명시적으로 등장한 숫자만 인용. *원문 표기 그대로* 사용.
- 뉴스에 없는 시총·매출·평가가치·목표주가를 *추정하거나 만들어내지 말 것*.
- 절대 "조", "경", "해" 단위 큰수를 임의로 생성하지 말 것. 뉴스 원문에 같은 표현이 없으면 그 숫자 자체를 적지 말 것.
- 정량 데이터가 뉴스에 없으면 정성적 표현으로만 작성. "예상된다", "전망이다" 같은 추정 표현으로 숫자를 끼워 넣지 말 것.

기타:
- 단기/중기/장기 thesis는 절대 동일 문장 반복 금지. 단기=임박 변수, 중기=분기 실적·정책, 장기=산업 구조.
- outlook의 thesis는 4문장 이상. 정량 수치는 뉴스 원문에 등장한 것만.
- events·capital_flow.signals·key_players는 뉴스 원문에 실제 등장한 것만. 추측·외부 지식 금지. 없으면 빈 배열.
${typeRules}`;

  // 폴백 순서 (provider별 독립 TPM 풀 활용):
  //   Cerebras 70B (최우선·무료·빠름) → Together 70B Free → Groq 70B → Groq 8B → Groq 8B축소
  const hasCerebras = !!process.env.CEREBRAS_API_KEY;
  const hasTogether = !!process.env.TOGETHER_API_KEY;
  const tries = [
    ...(hasCerebras ? [{ provider: 'cerebras', model: 'llama3.3-70b', maxTokens: 4000 }] : []),
    ...(hasTogether ? [{ provider: 'together', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', maxTokens: 4000 }] : []),
    { provider: 'groq', model: 'llama-3.3-70b-versatile', maxTokens: 4000 },
    { provider: 'groq', model: 'llama-3.1-8b-instant',    maxTokens: 3500 },
    { provider: 'groq', model: 'llama-3.1-8b-instant',    maxTokens: 2500 },
  ];
  let lastErrType = null;
  let _lastErr = null;
  for (let i = 0; i < tries.length; i++) {
    const { provider, model, maxTokens } = tries[i];
    try {
      const caller = provider === 'cerebras' ? callCerebras
                   : provider === 'together' ? callTogether
                   : callGroq;
      const text = await caller(model, [{ role: 'user', content: prompt }], maxTokens);
      console.log(`[gen] ${provider}:${model} 성공 (응답 ${text.length}자)`);
      try {
        const parsed = JSON.parse(text);
        return { ...parsed, generatedAt: new Date().toISOString(), _model: `${provider}:${model}` };
      } catch {
        lastErrType = 'parse';
        console.warn(`[keyword-agent] ${provider} ${model} JSON 파싱 실패 (${slug})`);
        if (i < tries.length - 1) await new Promise(r => setTimeout(r, 1500));
        continue;
      }
    } catch (e) {
      const msg = e.message || '';
      _lastErr = `${provider}:${model} → ${msg.slice(0, 200)}`;
      if (msg.includes('429')) lastErrType = 'rate_limit';
      else if (msg.includes('413')) lastErrType = 'too_large';
      else lastErrType = 'other';
      console.warn(`[keyword-agent] ${provider} ${model}(${maxTokens}) 실패 (${slug}):`, msg.slice(0, 200));
      if (lastErrType === 'other') break;
      if (i < tries.length - 1) await new Promise(r => setTimeout(r, 1500));
    }
  }
  return { _failure: lastErrType, _diag: { hasCerebras, hasTogether, lastErrType, _lastErr } };
}

// ── 환각 후처리 가드레일 ──────────────────────────────────
// LLM 응답의 정량 표현을 뉴스 원문과 대조해 환각 문장 제거.
// 보수적 필터: 의심되면 잘라낸다 (false positive 허용, false negative 차단).
function sanitizeInsight(insight, articles, opts = {}) {
  if (!insight || !articles?.length) return insight;
  const { extraFacts = '', validTickers = [] } = opts;
  // extraFacts: 목표주가 컨센서스 등 *우리가 검증해 주입한 실데이터*.
  // corpus에 합쳐 해당 수치 인용이 환각으로 잘리지 않게 한다.
  const corpus = articles.map(a => (a.t || '') + ' ' + (a.d || '') + ' ' + (a.fullText || '')).join(' ') + ' ' + extraFacts;
  const corpusNorm = corpus.replace(/[\s,]/g, '');

  const clean = (text) => {
    if (!text || typeof text !== 'string') return text;
    const sentences = text.split(/(?<=[.!?다요])\s+/).filter(s => s.trim());
    const kept = sentences.filter(s => {
      // 1. "경"/"해" 단위는 한국 단일종목 분석에 부적절 (한국 GDP가 ~2,400조 수준).
      //    뉴스 corpus에 있어도 보통 클릭베이트/추정 오류라 무조건 차단.
      if (/\d+\s*경(?![도력기제])/.test(s)) return false;
      if (/\d+\s*해(?![외당결군상기소운책약할제도])/.test(s)) return false;
      // 2. "조" 단위인데 4자리 이상(1000조 이상)도 단일 종목엔 비현실적 → 차단
      if (/[1-9]\d{3,}\s*조/.test(s)) return false;
      // 3. 큰 정량 표현이 뉴스 원문에 substring으로 없으면 그 문장 차단
      const quants = s.match(/\d[\d,.]*\s*(?:%|배|조|억원|억|만원|만달러|만)/g) || [];
      for (const q of quants) {
        const qNorm = q.replace(/[\s,]/g, '');
        if (!corpus.includes(q) && !corpusNorm.includes(qNorm)) return false;
      }
      // 4. 가격 표현 (X원, $X, X달러) — 4자리 이상이면 corpus 검증 (목표주가 환각 차단)
      const prices = s.match(/\d{1,3}(?:,\d{3})+\s*(?:원|달러)/g) || [];
      for (const p of prices) {
        const pNorm = p.replace(/[\s,]/g, '');
        if (!corpus.includes(p) && !corpusNorm.includes(pNorm)) return false;
      }
      return true;
    });
    return kept.join(' ').trim();
  };

  if (insight.summary) {
    const cleaned = clean(insight.summary);
    // 가드가 summary를 완전 비우면 원본 유지 (빈 화면 < 약한 환각)
    insight.summary = cleaned || insight.summary;
  }
  if (insight.outlook && typeof insight.outlook === 'object') {
    for (const k of ['short_term', 'mid_term', 'long_term']) {
      const v = insight.outlook[k];
      if (v && typeof v === 'object') {
        v.thesis = clean(v.thesis);
        v.upside = clean(v.upside);
        v.downside = clean(v.downside);
      }
    }
  }
  if (insight.capital_flow && typeof insight.capital_flow === 'object') {
    insight.capital_flow.summary = clean(insight.capital_flow.summary);
    if (Array.isArray(insight.capital_flow.signals)) {
      insight.capital_flow.signals = insight.capital_flow.signals
        .map(s => clean(s))
        .filter(s => s && s.length > 5);
    }
  }
  // PB 관점 — 가드 적용 (단 빈 문자열은 원본 유지)
  if (insight.pb_perspective && typeof insight.pb_perspective === 'object') {
    const pb = insight.pb_perspective;
    for (const k of ['valuation_assessment', 'momentum_signals', 'fundamental_strength', 'position_sizing_view']) {
      if (pb[k]) {
        const cleaned = clean(pb[k]);
        pb[k] = cleaned || pb[k]; // 통째로 잘리면 원본 유지
      }
    }
    if (Array.isArray(pb.key_monitors)) {
      pb.key_monitors = pb.key_monitors
        .map(s => typeof s === 'string' ? s : '')
        .filter(s => s && s.length > 4);
    }
  }
  // 시나리오: 메타 텍스트 제거 + 환각 가드 적용
  if (Array.isArray(insight.scenarios)) {
    const stripMeta = (s) => {
      if (!s || typeof s !== 'string') return s;
      return s
        .replace(/^\*[^*]+\*:\s*/, '')
        .replace(/^(이|이 시나리오가 현실화될|측정 가능한)[^:]*:\s*/, '')
        .trim();
    };
    // 시나리오는 PB 의사결정 근거 — 환각 잔존 위험을 빈 문자열보다 더 싫어함.
    // 폴백 없이 cleaned 결과 그대로 사용 (가격 환각이면 그 문장 그대로 제거).
    insight.scenarios = insight.scenarios.map(sc => ({
      ...sc,
      thesis: clean(stripMeta(sc.thesis)),
      trigger: clean(stripMeta(sc.trigger)),
    }));
  }
  // ── 타입별 추가 필드 가드 ──
  const tickerSet = new Set(validTickers);
  // 인물: statements — 문자열 검증 + ticker는 우리가 추적하는 코드만 (closed-set)
  if (Array.isArray(insight.statements)) {
    insight.statements = insight.statements
      .filter(st => st && typeof st.statement === 'string' && st.statement.trim().length > 5)
      .slice(0, 6)
      .map(st => ({
        date: (typeof st.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(st.date)) ? st.date : null,
        statement: clean(st.statement) || st.statement,
        context: typeof st.context === 'string' ? st.context.slice(0, 60) : '',
        signal: ['positive', 'negative', 'neutral'].includes(st.signal) ? st.signal : 'neutral',
        tickers: (Array.isArray(st.tickers) ? st.tickers : []).filter(t => tickerSet.has(t)),
      }))
      .filter(st => st.statement && st.statement.length > 5);
  }
  // 섹터: value_chain — 우리가 준 ticker의 분류만 허용 (새 종목 환각 차단)
  if (insight.value_chain && typeof insight.value_chain === 'object') {
    const vc = {};
    for (const k of ['upstream', 'midstream', 'downstream']) {
      vc[k] = (Array.isArray(insight.value_chain[k]) ? insight.value_chain[k] : [])
        .filter(t => tickerSet.has(t));
    }
    const total = vc.upstream.length + vc.midstream.length + vc.downstream.length;
    insight.value_chain = total >= 2 ? vc : null;
  }
  // 섹터: policy_tracker — 문자열 검증 + 환각 가드
  if (Array.isArray(insight.policy_tracker)) {
    insight.policy_tracker = insight.policy_tracker
      .filter(p => p && typeof p.title === 'string' && p.title.trim().length > 5)
      .slice(0, 5)
      .map(p => ({
        date: (typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date)) ? p.date : null,
        title: clean(p.title) || p.title,
        region: ['KR', 'US', 'EU', 'CN', '글로벌'].includes(p.region) ? p.region : '글로벌',
        stance: ['supportive', 'restrictive', 'neutral'].includes(p.stance) ? p.stance : 'neutral',
      }))
      .filter(p => p.title && p.title.length > 5);
  }
  // 기업: 토킹포인트 가드
  if (insight.pb_perspective && typeof insight.pb_perspective === 'object') {
    const pb = insight.pb_perspective;
    for (const k of ['talking_point_holders', 'talking_point_prospects']) {
      if (pb[k]) {
        const cleaned = clean(pb[k]);
        pb[k] = cleaned || pb[k];
      }
    }
  }
  return insight;
}

// ── 관련 테마 계산 ────────────────────────────────────────
// ticker가 겹치는 다른 키워드를 유사도 순으로 반환.
function findRelatedKeywords(currentSlug, currentTickers, allKeywords, topN = 4) {
  const curSet = new Set(currentTickers);
  return allKeywords
    .filter(k => k.slug !== currentSlug)
    .map(k => {
      const overlap = (k.tickers || []).filter(t => curSet.has(t)).length;
      return { slug: k.slug, name: k.name, icon: k.icon, tier: k.tier, overlap };
    })
    .filter(k => k.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, topN);
}

// ── 메인: 단일 키워드 처리 ───────────────────────────────
export async function runKeywordAgent(keywordConfig, allKeywords = [], benchmarks = null) {
  const { slug, name, tickers = [], type = 'sector', primaryTicker = null, peers = [], etfs = [] } = keywordConfig;
  const nameKo = name?.ko || slug;
  const keywords = buildKeywordAliases(keywordConfig);
  const lowerKeywords = keywords.map(k => k.toLowerCase());
  const dataDir = path.join(ROOT, 'public', 'data', 'keywords', slug);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  console.log(`[keyword-agent] "${nameKo}" 수집 시작 (별칭 ${keywords.length}개)`);

  // RSS 수집
  const all = [];
  for (const { url, src } of FEEDS) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(7000),
      });
      if (!r.ok) continue;
      all.push(...parseRSS(await r.text(), src, lowerKeywords));
    } catch {}
  }

  // 중복 제거 + 최신순 정렬
  const seen = new Set();
  const unique = all.filter(a => {
    const k = a.t.slice(0, 25);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).sort((a, b) => b.ts - a.ts).slice(0, 40);

  // 본문 크롤링 (동시 5개)
  const enriched = [];
  for (let i = 0; i < unique.length; i += 5) {
    const batch = unique.slice(i, i + 5);
    const texts = await Promise.all(batch.map(a => fetchFullText(a.u)));
    texts.forEach((ft, j) => enriched.push({ ...batch[j], fullText: ft }));
    if (i + 5 < unique.length) await new Promise(r => setTimeout(r, 400));
  }

  // 주가 조회 — 기업 키워드는 본체+경쟁사 컨센서스(목표주가·실적일)까지
  const consensusFor = type === 'company'
    ? [primaryTicker, ...peers].filter(Boolean)
    : (type === 'person' ? (keywordConfig.person?.influence?.direct || []).slice(0, 1) : []);
  const stockData = await fetchStockPrices(tickers, { consensusFor });

  // 섹터 키워드: 관련 ETF 시세 (개별 종목 리스크 회피 고객용)
  const etfData = (type === 'sector' && etfs.length)
    ? await fetchStockPrices(etfs)
    : null;

  // 기업 키워드: 본체 종목 변동성 기반 시나리오 가격 밴드
  const primary = primaryTicker ? stockData[primaryTicker] : null;
  const projection = (type === 'company' && primary)
    ? computeProjection(primary.prices, primary.px)
    : null;

  // 컨센서스 실데이터를 환각 가드 화이트리스트에 등록
  let extraFacts = '';
  if (primary?.consensus?.targetMean) {
    extraFacts = `목표주가 ${primary.consensus.targetMean} ${primary.consensus.targetMean.toLocaleString('en-US')} ${primary.consensus.targetMean.toLocaleString('ko-KR')}`;
  }

  // LLM 인사이트 (Groq TPM 한도 방어: 호출 간 4초 + 70B 우선 + 8B 폴백)
  await new Promise(r => setTimeout(r, 4000));
  let insight = await generateInsight(slug, nameKo, enriched, stockData, type, keywordConfig);
  // {_failure}는 실패 마커일 뿐 인사이트가 아님 — null로 강등해야
  // 아래의 "기존 인사이트 유지" 폴백이 실제로 작동한다 (이전엔 truthy라 폴백이 죽어있었음)
  let insightFailure = null;
  if (insight && insight._failure && !insight.summary) {
    insightFailure = insight._failure;
    insight = null;
  }
  // 환각 후처리: 뉴스에 없는 정량 표현이 들어간 문장 제거
  insight = sanitizeInsight(insight, enriched, { extraFacts, validTickers: tickers });

  // 뉴스 활동도 집계 (오늘 / 어제 / 7일 평균 / 매체 다양성)
  const now = Date.now();
  const dayMs = 86400000;
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const ydayStart = todayStart - dayMs;
  const weekStart = now - 7 * dayMs;
  const stats = (() => {
    const tsValid = enriched.filter(a => a.ts);
    const today = tsValid.filter(a => a.ts >= todayStart).length;
    const yesterday = tsValid.filter(a => a.ts >= ydayStart && a.ts < todayStart).length;
    const weekTotal = tsValid.filter(a => a.ts >= weekStart).length;
    const sources = new Set(enriched.map(a => a.s)).size;
    const heat = today >= 10 ? 'hot' : today >= 4 ? 'warm' : today >= 1 ? 'cool' : 'cold';
    return { today, yesterday, weekAvg: +(weekTotal / 7).toFixed(1), sources, heat };
  })();

  // news-live.json 저장
  fs.writeFileSync(
    path.join(dataDir, 'news-live.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), count: enriched.length, stats, items: enriched }, null, 2)
  );

  // 테마 지수 + 벤치마크 비교 (시장 대비 위치 차트용)
  const themeIndex = computeThemeIndex(stockData);
  const benchData = benchmarks && themeIndex.length
    ? {
        theme: themeIndex,
        kospi: normalize(benchmarks.kospi, themeIndex.length),
        sp500: normalize(benchmarks.sp500, themeIndex.length),
      }
    : null;

  // stock.json 저장 (etfs·projection은 해당 타입에서만 non-null)
  fs.writeFileSync(
    path.join(dataDir, 'stock.json'),
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      data: stockData,
      benchmark: benchData,
      etfs: etfData,
      projection,
    }, null, 2)
  );

  // ── 전망 히스토리 스냅샷 (적중률 트래킹용) ──
  // 하루 1개 (같은 날짜는 최신으로 교체). 90개 보관.
  // 프론트가 "그때 전망 vs 이후 실제 수익률"을 계산해 스코어카드 렌더링.
  try {
    const histPath = path.join(dataDir, 'history.json');
    let hist = [];
    try { hist = JSON.parse(fs.readFileSync(histPath, 'utf8')).entries || []; } catch {}
    const today = new Date().toISOString().slice(0, 10);
    const pricesMap = {};
    for (const [t, s] of Object.entries(stockData)) pricesMap[t] = s.px;
    if (Object.keys(pricesMap).length) {
      const snapSentiment = insight?.sentiment
        || (hist.length ? hist[hist.length - 1].sentiment : 'neutral');
      hist = hist.filter(h => h.date !== today);
      hist.push({ date: today, sentiment: snapSentiment, prices: pricesMap });
      hist = hist.slice(-90);
      fs.writeFileSync(histPath, JSON.stringify({ updatedAt: new Date().toISOString(), entries: hist }, null, 2));
    }
  } catch (e) { console.warn(`[keyword-agent] history 기록 실패 (${slug}):`, e.message); }

  // 관련 테마 (ticker 겹침 기반)
  const related = allKeywords.length ? findRelatedKeywords(slug, tickers, allKeywords) : [];

  // insight.json 저장
  // LLM 실패 시 기존 인사이트 유지(빈 화면 방지). related만 갱신.
  const insightPath = path.join(dataDir, 'insight.json');
  let previous = null;
  if (!insight && fs.existsSync(insightPath)) {
    try { previous = JSON.parse(fs.readFileSync(insightPath, 'utf8')); } catch {}
  }
  const emptyOutlook = { thesis: '', upside: '', downside: '' };
  const emptyShape = {
    summary: '', sentiment: 'neutral', key_drivers: [], watch_points: [], risks: [],
    events: [], key_players: [],
    outlook: { short_term: emptyOutlook, mid_term: emptyOutlook, long_term: emptyOutlook },
    capital_flow: { summary: '', signals: [] },
    scenarios: [],
    pb_perspective: { valuation_assessment: '', momentum_signals: '', fundamental_strength: '', key_monitors: [], position_sizing_view: '' },
  };
  const insightBody = insight
    || (previous && previous.summary ? { ...previous, _stale: true } : emptyShape);
  fs.writeFileSync(
    insightPath,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      related,
      ...insightBody,
      ...(insightFailure ? { _failure: insightFailure } : {}),
    }, null, 2)
  );

  console.log(`[keyword-agent] "${nameKo}" 완료: 뉴스 ${enriched.length}건, 주가 ${Object.keys(stockData).length}개, 인사이트 ${insight ? '✓' : '✗'}, 관련테마 ${related.length}개`);
  return { slug, articles: enriched.length, stocks: Object.keys(stockData).length, insight: !!insight };
}

// ── 별칭 + 관련 ticker 자동 추출 (LLM 1회 호출) ────────────
// 한국 종목은 *회사명만* 받고 우리 사전(tickers.json)에서 코드 변환 (환각 차단).
// 미국 종목은 알파벳 ticker 그대로 (LLM이 잘 알고 있음).
async function expandKeywordContext(query) {
  if (!process.env.GROQ_API_KEY) return { aliases: [query], tickers: [] };
  // 한국 회사명 → 코드 역방향 사전 (Closed-set 후처리)
  const nameMap = loadTickerNames();
  const krNameToCode = {};
  try {
    const t = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/tickers.json'), 'utf8'));
    for (const [code, name] of Object.entries(t.kr || {})) {
      krNameToCode[name] = code;
    }
  } catch {}
  const krCompanyList = Object.keys(krNameToCode);

  // Cerebras → Together → Groq 순 (각 provider TPM 풀 독립)
  const tryCall = async (messages, maxTokens) => {
    if (process.env.CEREBRAS_API_KEY) {
      try {
        return await callCerebras('llama3.3-70b', messages, maxTokens);
      } catch (e) {
        console.warn('[expandKeywordContext] Cerebras 실패, 폴백:', (e.message||'').slice(0, 80));
      }
    }
    if (process.env.TOGETHER_API_KEY) {
      try {
        return await callTogether('meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', messages, maxTokens);
      } catch (e) {
        console.warn('[expandKeywordContext] Together 실패, Groq 폴백:', (e.message||'').slice(0, 80));
      }
    }
    return callGroq('llama-3.1-8b-instant', messages, maxTokens);
  };

  try {
    const text = await tryCall([{
      role: 'user',
      content: `투자 키워드 "${query}"에 대해 키워드 타입, 뉴스 검색용 별칭, 관련 상장사를 JSON으로 반환해줘.

type 규칙 (셋 중 하나만):
- "person": 사람 이름 (CEO, 정치인, 투자자 등). 예: 일론 머스크, 젠슨 황, 워런 버핏
- "company": 단일 기업·종목 이름. 예: 테슬라, 삼성전자, 팔란티어
- "sector": 산업·테마·기술. 예: 양자컴퓨팅, 2차전지, 로보틱스
- 애매하면 "sector".

person_role (type이 person일 때만, 아니면 빈 문자열):
- 이 인물의 직책·소속 1문장. 모르면 빈 문자열.

aliases 규칙:
- 구별력 있는 *고유 명사* 위주: 영문 정식명, 약어, 핵심 기업·인물·제품명
- 일반 명사 절대 금지: "코인", "EV", "배터리", "에너지" 등
- 입력 키워드 자체 제외. 최대 8개.

us_tickers (미국 직접 관련):
- 알파벳 대문자 ticker만. 키워드와 *직접 관련된* 미국 상장사만.
- 모르면 빈 배열. 최대 2개.

us_competitors (미국 경쟁사):
- 키워드와 *경쟁/비교 가능한* 미국 상장사. PB가 페어 트레이드/비교 분석에 쓸 수 있어야 함.
- 같은 산업·세그먼트의 직접 경쟁자만. 추측 금지.
- 모르면 빈 배열. 최대 2개.

kr_companies (한국 직접 관련):
- 아래 *명단에서 정확한 회사명*만 선택. 명단 외 이름 절대 응답 금지.
- 키워드와 *직접 관련된* 회사만. 최대 2개.

kr_competitors (한국 경쟁사):
- 같은 *명단*에서 *경쟁사*만 선택. 같은 산업·세그먼트.
- PB가 비교 분석에 쓸 정도로 명확한 동종업계 경쟁자.
- 모르면 빈 배열. 최대 2개.

명단: ${JSON.stringify(krCompanyList)}

예시:
"테슬라"  → {"type":"company","person_role":"","aliases":["Tesla","TSLA","일론 머스크","사이버트럭"], "us_tickers":["TSLA"], "us_competitors":["F","GM"], "kr_companies":[], "kr_competitors":["005380","000270"]}
"일론 머스크" → {"type":"person","person_role":"테슬라·스페이스X CEO","aliases":["Elon Musk","머스크","테슬라 CEO","xAI"], "us_tickers":["TSLA"], "us_competitors":["F","GM"], "kr_companies":[], "kr_competitors":[]}
"카카오뱅크"→ {"type":"company","person_role":"","aliases":["Kakao Bank"], "us_tickers":[], "us_competitors":[], "kr_companies":["카카오뱅크"], "kr_competitors":["KB금융","신한지주"]}
"로보틱스" → {"type":"sector","person_role":"","aliases":["robotics","휴머노이드","로봇","Figure","Optimus"], "us_tickers":["NVDA"], "us_competitors":[], "kr_companies":["두산로보틱스"], "kr_competitors":[]}

JSON 스키마: {"type":"person|company|sector", "person_role":"...", "aliases":["..."], "us_tickers":["..."], "us_competitors":["..."], "kr_companies":["..."], "kr_competitors":["..."]}`
    }], 700);
    const parsed = JSON.parse(text);
    const blocked = new Set([
      // 기존 한글
      '코인','EV','배터리','에너지','모빌리티','투자','시장','가격','거래소','뉴스','반도체','자동차','기업','산업',
      // 금융 관련 일반어
      '뱅크','은행','증권','보험','금융','카드','페이','자산운용','펀드','ETF',
      // 기업 형태 일반어
      '그룹','홀딩스','지주','회사','계열사','계열','사업부',
      // 기술/IT 일반어
      '솔루션','시스템','시스템즈','테크','IT','플랫폼','서비스','네트워크','클라우드',
      // 시장/거래 일반어
      '주가','종목','관련주','테마','테마주','업종','분야','부문','상장',
      // 그 외 모호한 일반어
      '제품','신제품','글로벌','국내','해외','한국','미국',
      // 영문 일반어
      'Bank','Group','Holdings','Inc','Corp','Co','Ltd','LLC',
      'Tech','Pay','Card','Stock','Market','Fund','Securities',
      'Finance','Financial','Insurance','Capital','Investment','Investments',
      'Global','Korea','Korean','US','USA','China','Chinese','Asia','Asian',
      'Service','Services','Platform','System','Solution','Solutions',
      'Industry','Sector','Product','Products','Network','Cloud',
      'Company','Companies','Enterprise','Business','Tech', 'Technology','Technologies'
    ]);
    // 대소문자 무관 매칭을 위해 lowercase 비교도 추가
    const blockedLower = new Set([...blocked].map(s => s.toLowerCase()));
    let aliases = Array.isArray(parsed.aliases) ? parsed.aliases : [];
    aliases = aliases
      .filter(s => typeof s === 'string')
      .map(s => s.trim())
      .filter(s => s.length >= 2 && !blocked.has(s) && !blockedLower.has(s.toLowerCase()));

    // 미국 ticker: 알파벳 1~5자만 통과
    const parseUs = (arr) => (Array.isArray(arr) ? arr : [])
      .filter(s => typeof s === 'string')
      .map(s => s.trim().toUpperCase())
      .filter(s => /^[A-Z]{1,5}$/.test(s));
    const usDirect = parseUs(parsed.us_tickers);
    const usComp = parseUs(parsed.us_competitors);

    // 한국 회사명: 명단에 있는 것만 통과 → 우리 사전에서 코드로 변환
    const parseKr = (arr) => (Array.isArray(arr) ? arr : [])
      .filter(s => typeof s === 'string')
      .map(s => s.trim())
      .filter(s => krNameToCode[s])
      .map(s => krNameToCode[s]);
    const krDirect = parseKr(parsed.kr_companies);
    const krComp = parseKr(parsed.kr_competitors);

    // 중복 제거하면서 type 메타 유지 (direct가 competitor보다 우선)
    const tickerMap = new Map();
    [...usDirect, ...krDirect].forEach(t => tickerMap.set(t, 'direct'));
    [...usComp, ...krComp].forEach(t => { if (!tickerMap.has(t)) tickerMap.set(t, 'competitor'); });

    const tickers = Array.from(tickerMap.keys()).slice(0, 7);
    const relations = {};
    tickers.forEach(t => { relations[t] = tickerMap.get(t); });

    // 키워드 타입 분류 (검증 실패 시 sector로 강등)
    const type = ['person', 'company', 'sector'].includes(parsed.type) ? parsed.type : 'sector';
    const personRole = (type === 'person' && typeof parsed.person_role === 'string')
      ? parsed.person_role.slice(0, 80) : '';
    // 기업/인물의 기준 종목 = 첫 번째 직접 관련 ticker
    const directTickers = tickers.filter(t => relations[t] === 'direct');
    const primaryTicker = directTickers[0] || null;

    return {
      aliases: [query, ...aliases].slice(0, 10),
      tickers,
      relations,
      type,
      personRole,
      primaryTicker,
    };
  } catch {
    return { aliases: [query], tickers: [], relations: {}, type: 'sector', personRole: '', primaryTicker: null };
  }
}

// ── 온디맨드 리서치 (사용자 입력 키워드, 파일 저장 없음) ──────
// 카탈로그 외 임의 키워드에 대해 빠르게 결과 객체만 반환.
// 본문 크롤링 생략 + 주가 호출 생략으로 15~25초 안에 끝남.
export async function researchKeywordOnDemand(query) {
  const q = (query || '').trim();
  if (!q) throw new Error('query empty');

  // 1단계: LLM이 키워드 타입 + 별칭 + 직접 관련 ticker + 경쟁사 ticker 동적 추출
  const {
    aliases: expandedAliases, tickers: extractedTickers, relations: tickerRelations,
    type, personRole, primaryTicker,
  } = await expandKeywordContext(q);

  // 인물: 직접 영향 / 생태계(경쟁·연관) 분리
  const directTickers = extractedTickers.filter(t => tickerRelations[t] === 'direct');
  const personInfluence = type === 'person'
    ? { direct: directTickers, ecosystem: extractedTickers.filter(t => tickerRelations[t] !== 'direct') }
    : null;
  // 기업: 경쟁사 목록 (프론트 그룹핑·비교 테이블용)
  const peers = type === 'company'
    ? extractedTickers.filter(t => tickerRelations[t] === 'competitor')
    : [];

  const config = {
    slug: q,
    name: { ko: q, en: q },
    aliases: expandedAliases,
  };
  const keywords = buildKeywordAliases(config);
  const lowerKeywords = keywords.map(k => k.toLowerCase());

  // 기준 종목 컨센서스(목표주가·실적일): 기업=본체+경쟁사, 인물=직접 영향 1순위
  const consensusFor = type === 'company'
    ? [primaryTicker, ...peers].filter(Boolean)
    : (type === 'person' ? directTickers.slice(0, 1) : []);

  // 1. 병렬 수집: RSS 16개 + Google News + (ticker 있으면) 주가 + 벤치마크
  const hasTickers = extractedTickers.length > 0;
  const [feedResults, googleNews, stockData, benchmarks] = await Promise.all([
    Promise.allSettled(FEEDS.map(async ({ url, src }) => {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000) });
        if (!r.ok) return [];
        return parseRSS(await r.text(), src, lowerKeywords);
      } catch { return []; }
    })),
    fetchGoogleNewsForAliases(expandedAliases),
    hasTickers ? fetchStockPrices(extractedTickers, { consensusFor }) : Promise.resolve({}),
    hasTickers ? fetchBenchmarks() : Promise.resolve(null),
  ]);
  const all = feedResults.flatMap(x => x.status === 'fulfilled' ? x.value : []).concat(googleNews);

  // 2. 중복 제거 + 최신순
  const seen = new Set();
  const unique = all.filter(a => {
    const k = a.t.slice(0, 25);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).sort((a, b) => b.ts - a.ts).slice(0, 15);

  if (!unique.length) {
    return {
      query: q,
      updatedAt: new Date().toISOString(),
      ok: false,
      reason: 'no_news',
      message: `"${q}" 관련 뉴스를 찾지 못했습니다.`,
      aliasesUsed: expandedAliases,
      type,
      news: [],
      insight: null,
    };
  }

  // stockData에 relation(direct/competitor) 메타 임베드
  if (stockData && tickerRelations) {
    for (const code of Object.keys(stockData)) {
      stockData[code].relation = tickerRelations[code] || 'direct';
    }
  }

  // 기업: 본체 종목 변동성 기반 시나리오 가격 밴드
  const primary = primaryTicker ? stockData[primaryTicker] : null;
  const projection = (type === 'company' && primary)
    ? computeProjection(primary.prices, primary.px)
    : null;

  // 컨센서스 실데이터 화이트리스트 (환각 가드가 잘라내지 않도록)
  let extraFacts = '';
  if (primary?.consensus?.targetMean) {
    extraFacts = `목표주가 ${primary.consensus.targetMean} ${primary.consensus.targetMean.toLocaleString('en-US')} ${primary.consensus.targetMean.toLocaleString('ko-KR')}`;
  }

  // 3. LLM 인사이트 — 타입별 프롬프트 분기 (이제 stockData 활용 가능)
  const pseudoConfig = {
    primaryTicker,
    peers,
    person: personInfluence ? { title: personRole, influence: personInfluence } : null,
  };
  let insight = await generateInsight(q, q, unique, stockData, type, pseudoConfig);
  insight = sanitizeInsight(insight, unique, { extraFacts, validTickers: extractedTickers });

  // 4. 테마 지수 + 벤치마크
  const themeIndex = computeThemeIndex(stockData);
  const benchData = benchmarks && themeIndex.length
    ? {
        theme: themeIndex,
        kospi: normalize(benchmarks.kospi, themeIndex.length),
        sp500: normalize(benchmarks.sp500, themeIndex.length),
      }
    : null;

  return {
    query: q,
    updatedAt: new Date().toISOString(),
    ok: true,
    count: unique.length,
    aliasesUsed: expandedAliases,
    tickersUsed: extractedTickers,
    type,
    primaryTicker,
    peers,
    person: personInfluence ? { title: personRole, influence: personInfluence } : null,
    news: unique,
    insight,
    stock: hasTickers ? { data: stockData, benchmark: benchData, projection } : null,
  };
}
