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

function parseRSS(xml, src, keywords) {
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
    const text = title + ' ' + desc;
    if (!keywords.some(kw => text.includes(kw))) continue;
    items.push({
      s: src, t: title, d: desc, u: link,
      m: date ? new Date(date).toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '',
      ts: date ? new Date(date).getTime() : 0,
    });
  }
  return items;
}

// ── 키워드 별칭 생성 ──────────────────────────────────────
function buildKeywordAliases(slug, nameKo) {
  const base = [slug, nameKo];
  const extras = {
    'HBM':        ['고대역폭메모리', 'HBM4', 'HBM3E', '광대역메모리'],
    'AI반도체':   ['AI칩', 'AI 가속기', 'GPU', 'NPU', 'AI chip', 'AI semiconductor'],
    '피지컬AI':   ['피지컬AI', 'Physical AI', '로보틱스', 'humanoid', '휴머노이드'],
    '전기차':     ['EV', '전기차', '전기자동차', 'electric vehicle', 'BEV'],
    'K배터리':    ['2차전지', '배터리', '리튬이온', 'LFP', 'NCM', '전고체'],
    'AI인프라':   ['데이터센터', 'AI 인프라', 'AI infrastructure', '추론', 'inference'],
    '자율주행':   ['자율주행', 'autonomous', 'FSD', '로보택시', 'robotaxi'],
    '소버린AI':   ['소버린AI', 'Sovereign AI', '국가AI', '국산AI', 'AI주권'],
    '반도체장비': ['반도체 장비', '노광', 'EUV', 'ASML', '식각', 'CVD', '웨이퍼'],
    '클라우드':   ['클라우드', 'cloud', 'AWS', 'Azure', 'GCP', 'SaaS'],
    '양자컴퓨팅': ['양자컴퓨터', 'quantum', 'qubit'],
    '수소':       ['수소', 'hydrogen', '연료전지', 'fuel cell', '그린수소'],
    '방산':       ['방산', 'defense', '우주', 'space', 'K9', '천무', 'KF-21'],
    '바이오':     ['바이오', 'bio', '제약', 'pharma', '신약', '항암', 'FDA'],
    '핀테크':     ['핀테크', 'fintech', '디지털금융', '블록체인', 'blockchain', 'DeFi'],
    'TSMC파운드리':['TSMC', '파운드리', 'foundry', '대만 반도체', '삼성 파운드리'],
    '엔비디아생태계':['엔비디아', 'NVIDIA', 'NVDA', 'Blackwell', '블랙웰', 'GTC'],
    '신재생에너지':['태양광', '풍력', '신재생', 'renewable', 'solar', 'wind power'],
    'AI에이전트': ['AI 에이전트', 'AI agent', 'LLM', '거대언어모델', 'GPT', 'Claude'],
    '스마트팩토리':['스마트팩토리', '산업AI', 'smart factory', '제조AI', 'IIoT'],
  };
  return [...base, ...(extras[slug] || [])];
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
        results[ticker] = {
          px: meta.regularMarketPrice,
          dayChange: +(meta.regularMarketChangePercent || 0).toFixed(2),
          currency: meta.currency || 'USD',
          state: meta.marketState || 'CLOSED',
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
  const stockSummary = Object.entries(stockData).slice(0, 5)
    .map(([code, s]) => `${code}: ${s.currency === 'KRW' ? '₩' : '$'}${s.px} (${s.dayChange >= 0 ? '+' : ''}${s.dayChange}%)`).join(', ');
  try {
    const text = await callGroq('llama-3.3-70b-versatile', [{
      role: 'user',
      content: `투자 테마 "${nameKo}" 관련 오늘 뉴스와 주가를 분석해서 JSON으로 반환해줘.

최신 뉴스:
${top5}

관련 주가: ${stockSummary || '데이터 없음'}

JSON 형식:
{
  "summary": "핵심 동향 2~3문장",
  "sentiment": "bullish|bearish|neutral",
  "key_drivers": ["주요 동력 1", "주요 동력 2"],
  "watch_points": ["주목 포인트 1", "주목 포인트 2"],
  "disclaimer": "본 분석은 AI가 생성한 정보이며 투자 권유가 아닙니다."
}`
    }], 600);
    return { ...JSON.parse(text), generatedAt: new Date().toISOString(), _model: 'llama-3.3-70b' };
  } catch { return null; }
}

// ── 메인: 단일 키워드 처리 ───────────────────────────────
export async function runKeywordAgent(keywordConfig) {
  const { slug, name, tickers = [] } = keywordConfig;
  const nameKo = name?.ko || slug;
  const keywords = buildKeywordAliases(slug, nameKo);
  const dataDir = path.join(ROOT, 'public', 'data', 'keywords', slug);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  console.log(`[keyword-agent] "${nameKo}" 수집 시작`);

  // RSS 수집
  const all = [];
  for (const { url, src } of FEEDS) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(7000),
      });
      if (!r.ok) continue;
      all.push(...parseRSS(await r.text(), src, keywords));
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

  // insight.json 저장
  if (insight) {
    fs.writeFileSync(
      path.join(dataDir, 'insight.json'),
      JSON.stringify({ updatedAt: new Date().toISOString(), ...insight }, null, 2)
    );
  }

  console.log(`[keyword-agent] "${nameKo}" 완료: 뉴스 ${enriched.length}건, 주가 ${Object.keys(stockData).length}개, 인사이트 ${insight ? '✓' : '✗'}`);
  return { slug, articles: enriched.length, stocks: Object.keys(stockData).length, insight: !!insight };
}
