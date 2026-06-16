#!/usr/bin/env node
/**
 * 배치 러너 — 20개 키워드를 tier별로 배치 처리
 * hot(즉시) → warm(지연 5초) → cold(지연 10초)
 */
import { runKeywordAgent, fetchBenchmarks } from '../agents/keyword-agent.js';
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

  // 벤치마크 (KOSPI, S&P500) 한 번만 fetch해서 모든 키워드에 재사용
  console.log('[batch-runner] 벤치마크 fetch 중...');
  const benchmarks = await fetchBenchmarks();
  console.log(`[batch-runner] 벤치마크: KOSPI ${benchmarks.kospi.length}일, S&P500 ${benchmarks.sp500.length}일`);

  // E 방식: 외부 fetch만 병렬, LLM은 글로벌 큐(withLLMLock)로 직렬화
  // RPM 30 한도는 LLM 큐가 관리하므로 CONCURRENCY를 외부 IO 기준으로 상향 가능
  // 예상: ~7~9분 + 인사이트 갱신 100% 보장
  const CONCURRENCY = 6;
  const results = [];
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    console.log(`[batch-runner] 배치 ${Math.floor(i/CONCURRENCY)+1}/${Math.ceil(targets.length/CONCURRENCY)}: [${batch.map(k => k.slug).join(', ')}]`);
    const batchResults = await Promise.all(batch.map(async (kw) => {
      try {
        const r = await runKeywordAgent(kw, index.keywords, benchmarks);
        return { ...r, ok: true };
      } catch (e) {
        console.error(`[batch-runner] ${kw.slug} 실패:`, e.message);
        return { slug: kw.slug, ok: false, error: e.message };
      }
    }));
    results.push(...batchResults);
    // 배치 간 짧은 sleep (외부 사이트 부하 방어). LLM 한도는 글로벌 큐가 관리.
    if (i + CONCURRENCY < targets.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
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
