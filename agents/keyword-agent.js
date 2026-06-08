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
  { url: 'https://www.mk.co.kr/rss/30000001/',                            src: '매일경제' },
  { url: 'https://rss.donga.com/total.xml',                               src: '동아일보' },
  { url: 'https://www.chosun.com/arc/outboundfeeds/rss/?outputType=xml',  src: '조선일보' },
  { url: 'https://www.newsis.com/rss/realnews.xml',                       src: '뉴시스'   },
  { url: 'https://www.hani.co.kr/rss/economy',                            src: '한겨레'   },
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
// 한국 주식 6자리 코드는 .KS(코스피) → .KQ(코스닥) 순으로 폴백
async function fetchYahoo(symbol) {
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
    { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(6000) }
  );
  if (!r.ok) return null;
  const data = await r.json();
  return data?.chart?.result?.[0]?.meta || null;
}

async function fetchStockPrices(tickers) {
  const nameMap = loadTickerNames();
  const results = {};
  await Promise.allSettled(tickers.map(async ticker => {
    try {
      const isKR = /^\d{6}$/.test(ticker);
      const candidates = isKR ? [`${ticker}.KS`, `${ticker}.KQ`] : [ticker];
      let meta = null;
      for (const sym of candidates) {
        meta = await fetchYahoo(sym);
        if (meta?.regularMarketPrice) break;
      }
      if (meta?.regularMarketPrice) {
        const fallbackName = (meta.shortName && !/^\d/.test(meta.shortName)) ? meta.shortName : ticker;
        results[ticker] = {
          name: nameMap[ticker] || fallbackName,
          px: meta.regularMarketPrice,
          dayChange: +(meta.regularMarketChangePercent || 0).toFixed(2),
          currency: meta.currency || 'USD',
          state: meta.marketState || 'CLOSED',
          market: isKR ? 'KR' : 'US',
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
  try {
    const text = await callGroq('llama-3.3-70b-versatile', [{
      role: 'user',
      content: `투자 테마 "${nameKo}" 관련 뉴스·주가를 분석해 한국어 JSON으로 반환해줘. 오늘은 ${today}.

뉴스:
${top5}

관련 종목: ${stockSummary || '데이터 없음'}

JSON 스키마:
{
  "summary": "핵심 동향 2~3문장",
  "sentiment": "bullish|bearish|neutral",
  "key_drivers": ["주요 동력 2~4개. 무엇이 테마를 움직이는지"],
  "watch_points": ["관전 포인트 2~4개. 무엇을 지켜봐야 하는지"],
  "risks": ["주요 리스크 1~3개. 하방 요인"],
  "events": [
    { "date": "YYYY-MM-DD 또는 YYYY-Qn 또는 'TBD'", "title": "예정 이벤트(실적 발표/제품 출시/상장/규제 등)", "impact": "positive|negative|neutral" }
  ],
  "key_players": ["테마를 주도하는 기업·인물 2~5개. 한글 표기 우선"],
  "disclaimer": "본 분석은 AI 생성 정보이며 투자 권유가 아닙니다."
}

규칙:
- events는 뉴스에서 명시적으로 언급된 예정 이벤트만 포함. 없으면 빈 배열.
- key_players는 뉴스에 실제 등장한 기업·인물만. 추측 금지.`
    }], 900);
    return { ...JSON.parse(text), generatedAt: new Date().toISOString(), _model: 'llama-3.3-70b' };
  } catch { return null; }
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
export async function runKeywordAgent(keywordConfig, allKeywords = []) {
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

  // LLM 인사이트
  await new Promise(r => setTimeout(r, 1200)); // Rate limit 방어
  const insight = await generateInsight(slug, nameKo, enriched, stockData);

  // news-live.json 저장
  fs.writeFileSync(
    path.join(dataDir, 'news-live.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), count: enriched.length, items: enriched }, null, 2)
  );

  // stock.json 저장
  fs.writeFileSync(
    path.join(dataDir, 'stock.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), data: stockData }, null, 2)
  );

  // 관련 테마 (ticker 겹침 기반)
  const related = allKeywords.length ? findRelatedKeywords(slug, tickers, allKeywords) : [];

  // insight.json 저장
  fs.writeFileSync(
    path.join(dataDir, 'insight.json'),
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      related,
      ...(insight || { summary: '', sentiment: 'neutral', key_drivers: [], watch_points: [], risks: [], events: [], key_players: [] }),
    }, null, 2)
  );

  console.log(`[keyword-agent] "${nameKo}" 완료: 뉴스 ${enriched.length}건, 주가 ${Object.keys(stockData).length}개, 인사이트 ${insight ? '✓' : '✗'}, 관련테마 ${related.length}개`);
  return { slug, articles: enriched.length, stocks: Object.keys(stockData).length, insight: !!insight };
}
