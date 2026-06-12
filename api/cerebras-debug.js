export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const key = process.env.CEREBRAS_API_KEY;
  if (!key) return res.status(400).json({ error: 'CEREBRAS_API_KEY not set' });

  try {
    const r = await fetch('https://api.cerebras.ai/v1/models', {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    const data = await r.json();
    return res.status(200).json({
      keyLen: key.length,
      keyPrefix: key.slice(0, 8),
      status: r.status,
      models: data,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
