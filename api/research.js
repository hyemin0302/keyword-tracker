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
    // 같은 키워드는 10분 캐시, 30분간 stale 응답 허용
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1800');
    res.status(200).json(result);
  } catch (e) {
    console.error('[api/research]', e?.message);
    res.status(500).json({ error: 'internal', message: e?.message });
  }
}
