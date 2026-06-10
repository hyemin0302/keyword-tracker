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
    signal: AbortSignal.timeout(20000),
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
async function fetchYahoo(symbol) {
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1mo`,
    { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000) }
  );
  if (!r.ok) return null;
  const data = await r.json();
  const result = data?.chart?.result?.[0];
  if (!result) return null;
  const closes = (result.indicators?.quote?.[0]?.close || []).filter(v => v != null);
  return { meta: result.meta, closes };
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
    };
  } catch { return null; }
}

function valuationFromMeta(meta) {
  if (!meta) return null;
  return {
    high52w: meta.fiftyTwoWeekHigh,
    low52w: meta.fiftyTwoWeekLow,
    volume: meta.regularMarketVolume,
  };
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

async function fetchStockPrices(tickers) {
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
        // 펀더멘털: 한국은 네이버, 미국은 chart meta에서 추출 가능한 항목만
        const fundamentals = isKR ? await fetchValuationKR(ticker) : valuationFromMeta(meta);
        results[ticker] = {
          name: nameMap[ticker] || fallbackName,
          px: meta.regularMarketPrice,
          dayChange: +(meta.regularMarketChangePercent || 0).toFixed(2),
          periodChange,
          prices: closes,
          currency: meta.currency || 'USD',
          state: meta.marketState || 'CLOSED',
          market: isKR ? 'KR' : 'US',
          fundamentals,
        };
      }
    } catch {}
  }));
  return results;
}

// ── LLM 인사이트 생성 ────────────────────────────────────
async function generateInsight(slug, nameKo, articles, stockData) {
  if (!process.env.GROQ_API_KEY || !articles.length) return null;
  const top5 = articles.slice(0, 5).map((a, i) => `[${i+1}] ${a.s}: ${a.t} — ${a.d?.slice(0,100)}`).join('\n');
  const stockSummary = Object.entries(stockData).slice(0, 6)
    .map(([code, s]) => `${s.name || code}(${code}): ${s.currency === 'KRW' ? '₩' : '$'}${s.px}`).join(', ');
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `투자 테마 "${nameKo}" 관련 뉴스·주가를 분석해 한국어 JSON으로 반환해줘. 오늘은 ${today}.

뉴스:
${top5}

관련 종목: ${stockSummary || '데이터 없음'}

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
  "disclaimer": "본 분석은 AI 생성 정보이며 투자 권유가 아닙니다."
}

절대 규칙:
- 모든 텍스트는 순 한국어. 한자(延期 등) 금지. 불가피하면 괄호 병기.
- 모든 분석은 위에 제공된 뉴스에 *명시적으로 등장한 사실*만 사용. 등장하지 않은 기업명·수치·이벤트는 절대 추가하지 말 것. 모르면 "관련 뉴스 없음"이라 솔직히 적기.

수치 인용 절대 규칙 (가장 중요 - 환각 방지):
- 뉴스에 명시적으로 등장한 숫자만 인용. *원문 표기 그대로* 사용.
- 뉴스에 없는 시총·매출·평가가치·목표주가를 *추정하거나 만들어내지 말 것*.
- 절대 "조", "경", "해" 단위 큰수를 임의로 생성하지 말 것. 뉴스 원문에 같은 표현이 없으면 그 숫자 자체를 적지 말 것.
- 정량 데이터가 뉴스에 없으면 정성적 표현으로만 작성. "예상된다", "전망이다" 같은 추정 표현으로 숫자를 끼워 넣지 말 것.

기타:
- 단기/중기/장기 thesis는 절대 동일 문장 반복 금지. 단기=임박 변수, 중기=분기 실적·정책, 장기=산업 구조.
- outlook의 thesis는 4문장 이상. 정량 수치는 뉴스 원문에 등장한 것만.
- events·capital_flow.signals·key_players는 뉴스 원문에 실제 등장한 것만. 추측·외부 지식 금지. 없으면 빈 배열.`;

  // 70B → 429면 8B로 폴백. 429 외 오류는 즉시 중단.
  const models = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
  for (const model of models) {
    try {
      const text = await callGroq(model, [{ role: 'user', content: prompt }], 2000);
      return { ...JSON.parse(text), generatedAt: new Date().toISOString(), _model: model };
    } catch (e) {
      const msg = e.message || '';
      console.warn(`[keyword-agent] LLM ${model} 실패 (${slug}):`, msg.slice(0, 120));
      if (!msg.includes('429')) break;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  return null;
}

// ── 환각 후처리 가드레일 ──────────────────────────────────
// LLM 응답의 정량 표현을 뉴스 원문과 대조해 환각 문장 제거.
// 보수적 필터: 의심되면 잘라낸다 (false positive 허용, false negative 차단).
function sanitizeInsight(insight, articles) {
  if (!insight || !articles?.length) return insight;
  const corpus = articles.map(a => (a.t || '') + ' ' + (a.d || '') + ' ' + (a.fullText || '')).join(' ');
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
      return true;
    });
    return kept.join(' ').trim();
  };

  if (insight.summary) insight.summary = clean(insight.summary);
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
  const { slug, name, tickers = [] } = keywordConfig;
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

  // 주가 조회
  const stockData = await fetchStockPrices(tickers);

  // LLM 인사이트 (Groq TPM 한도 방어: 호출 간 4초 + 70B 우선 + 8B 폴백)
  await new Promise(r => setTimeout(r, 4000));
  let insight = await generateInsight(slug, nameKo, enriched, stockData);
  // 환각 후처리: 뉴스에 없는 정량 표현이 들어간 문장 제거
  insight = sanitizeInsight(insight, enriched);

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

  // stock.json 저장
  fs.writeFileSync(
    path.join(dataDir, 'stock.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), data: stockData, benchmark: benchData }, null, 2)
  );

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
  };
  const insightBody = insight
    || (previous && previous.summary ? { ...previous, _stale: true } : emptyShape);
  fs.writeFileSync(
    insightPath,
    JSON.stringify({ updatedAt: new Date().toISOString(), related, ...insightBody }, null, 2)
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

  try {
    const text = await callGroq('llama-3.1-8b-instant', [{
      role: 'user',
      content: `투자 키워드 "${query}"에 대해 뉴스 검색용 별칭과 관련 상장사를 JSON으로 반환해줘.

aliases 규칙:
- 구별력 있는 *고유 명사* 위주: 영문 정식명, 약어, 핵심 기업·인물·제품명
- 일반 명사 절대 금지: "코인", "EV", "배터리", "에너지" 등
- 입력 키워드 자체 제외. 최대 8개.

us_tickers 규칙 (미국 상장):
- 알파벳 대문자 ticker만 (TSLA, NVDA, COIN, MSTR 등)
- 키워드와 *직접 관련된* 미국 상장사만. 추측 절대 금지.
- 모르면 빈 배열. 최대 3개.

kr_companies 규칙 (한국 상장):
- 아래 *명단에서 정확한 회사명*만 선택. 명단 외 이름 절대 응답 금지.
- 명단: ${JSON.stringify(krCompanyList)}
- 키워드와 *직접 관련된* 회사만. 추측·유추 금지.
- 명단에 없으면 빈 배열. 최대 3개.

예시:
"테슬라"  → {"aliases":["Tesla","TSLA","일론 머스크","Elon Musk","사이버트럭"], "us_tickers":["TSLA"], "kr_companies":[]}
"비트코인" → {"aliases":["Bitcoin","BTC","Coinbase","마이크로스트래티지"], "us_tickers":["COIN","MSTR","MARA"], "kr_companies":[]}
"삼성SDS" → {"aliases":["삼성에스디에스","Samsung SDS","스마트팩토리","Brity AI"], "us_tickers":[], "kr_companies":["삼성에스디에스"]}
"엔비디아" → {"aliases":["NVIDIA","NVDA","젠슨 황","Blackwell"], "us_tickers":["NVDA","TSM"], "kr_companies":["SK하이닉스"]}

JSON 스키마: {"aliases": ["..."], "us_tickers": ["..."], "kr_companies": ["..."]}`
    }], 600);
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
    let usTickers = Array.isArray(parsed.us_tickers) ? parsed.us_tickers : [];
    usTickers = usTickers
      .filter(s => typeof s === 'string')
      .map(s => s.trim().toUpperCase())
      .filter(s => /^[A-Z]{1,5}$/.test(s));

    // 한국 회사명: 명단에 있는 것만 통과 → 우리 사전에서 코드로 변환 (환각 차단)
    let krCompanies = Array.isArray(parsed.kr_companies) ? parsed.kr_companies : [];
    const krCodes = krCompanies
      .filter(s => typeof s === 'string')
      .map(s => s.trim())
      .filter(s => krNameToCode[s])
      .map(s => krNameToCode[s]);

    const tickers = [...usTickers, ...krCodes].slice(0, 5);
    return {
      aliases: [query, ...aliases].slice(0, 10),
      tickers,
    };
  } catch {
    return { aliases: [query], tickers: [] };
  }
}

// ── 온디맨드 리서치 (사용자 입력 키워드, 파일 저장 없음) ──────
// 카탈로그 외 임의 키워드에 대해 빠르게 결과 객체만 반환.
// 본문 크롤링 생략 + 주가 호출 생략으로 15~25초 안에 끝남.
export async function researchKeywordOnDemand(query) {
  const q = (query || '').trim();
  if (!q) throw new Error('query empty');

  // 1단계: LLM이 별칭 + 관련 ticker 동적 추출
  const { aliases: expandedAliases, tickers: extractedTickers } = await expandKeywordContext(q);

  const config = {
    slug: q,
    name: { ko: q, en: q },
    aliases: expandedAliases,
  };
  const keywords = buildKeywordAliases(config);
  const lowerKeywords = keywords.map(k => k.toLowerCase());

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
    hasTickers ? fetchStockPrices(extractedTickers) : Promise.resolve({}),
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
      news: [],
      insight: null,
    };
  }

  // 3. LLM 인사이트 (이제 stockData 활용 가능)
  let insight = await generateInsight(q, q, unique, stockData);
  const _diag = {
    hasGroqKey: !!process.env.GROQ_API_KEY,
    groqKeyLen: (process.env.GROQ_API_KEY || '').length,
    insightBeforeSanitize: insight ? { model: insight._model, summaryLen: (insight.summary||'').length } : null,
  };
  insight = sanitizeInsight(insight, unique);
  _diag.insightAfterSanitize = insight ? { summaryLen: (insight.summary||'').length } : null;

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
    news: unique,
    insight,
    stock: hasTickers ? { data: stockData, benchmark: benchData } : null,
    _diag,
  };
}
