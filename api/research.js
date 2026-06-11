import { researchKeywordOnDemand } from '../agents/keyword-agent.js';

export const config = {
  maxDuration: 300,
};

export default async function handler(req, res) {
  const q = (req.query?.q || '').toString().trim();
  if (!q) {
    res.status(400).json({ error: 'q required' });
    return;
  }
  if (q.length > 50) {
    res.status(400).json({ error: 'q too long (max 50 chars)' });
    return;
  }

  try {
    const result = await researchKeywordOnDemand(q);
    // 빈 인사이트 or 뉴스 0건은 캐시 X (다음 호출에 재시도 기회 주기)
    const hasInsight = result?.insight && (result.insight.summary || '').length > 0;
    const hasNews = result?.ok && (result?.count || 0) > 0;
    if (hasInsight && hasNews) {
      res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    } else {
      res.setHeader('Cache-Control', 'no-store');
    }
    res.status(200).json(result);
  } catch (e) {
    console.error('[api/research]', e?.message);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: 'internal', message: e?.message });
  }
}
