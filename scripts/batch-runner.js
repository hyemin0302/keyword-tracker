#!/usr/bin/env node
/**
 * 배치 러너 — 20개 키워드를 tier별로 배치 처리
 * hot(즉시) → warm(지연 5초) → cold(지연 10초)
 */
import { runKeywordAgent } from '../agents/keyword-agent.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'public', 'data', 'keywords', 'index.json');

const RUN_TIER = process.env.RUN_TIER || 'all'; // hot | warm | cold | all

async function main() {
  console.log(`[batch-runner] ${new Date().toISOString()} 시작 (tier: ${RUN_TIER})`);
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  const targets = index.keywords.filter(k =>
    RUN_TIER === 'all' || k.tier === RUN_TIER
  );

  console.log(`[batch-runner] 대상 키워드: ${targets.length}개`);

  const results = [];
  for (const kw of targets) {
    try {
      const r = await runKeywordAgent(kw, index.keywords);
      results.push({ ...r, ok: true });
    } catch (e) {
      console.error(`[batch-runner] ${kw.slug} 실패:`, e.message);
      results.push({ slug: kw.slug, ok: false, error: e.message });
    }
    // tier별 딜레이 (Rate limit 방어)
    const delay = kw.tier === 'hot' ? 2000 : kw.tier === 'warm' ? 3000 : 5000;
    await new Promise(r => setTimeout(r, delay));
  }

  // meta.json 업데이트
  const meta = {
    updatedAt: new Date().toISOString(),
    tier: RUN_TIER,
    total: targets.length,
    success: results.filter(r => r.ok).length,
    results,
  };
  fs.writeFileSync(
    path.join(ROOT, 'public', 'data', 'meta.json'),
    JSON.stringify(meta, null, 2)
  );

  console.log(`[batch-runner] 완료: ${meta.success}/${meta.total}개 성공`);
}

main().catch(e => { console.error('[batch-runner] 치명적 오류:', e.message); process.exit(1); });
