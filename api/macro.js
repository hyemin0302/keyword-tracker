import { fetchMacro } from '../agents/keyword-agent.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  try {
    const data = await fetchMacro();
    // 15분 CDN 캐시 + 1시간 stale
    res.setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600');
    res.status(200).json({ updatedAt: new Date().toISOString(), data });
  } catch (e) {
    console.error('[api/macro]', e?.message);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: 'internal', message: e?.message });
  }
}
