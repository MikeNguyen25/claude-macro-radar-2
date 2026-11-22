// Tiến trình nền của bàn thử cấu hình: tải số liệu thô của artifact, chạy kiểm định với cấu hình hiện
// hành và cấu hình thử trên cùng số liệu, trả bảng so sánh.

import { runEngine, mergeConfig, HORIZONS } from '../engine/index.mjs';

const CANDS = ['M2', 'M3', 'M4', 'M5'];

function summarize(run) {
  const out = {};
  for (const h of HORIZONS) {
    out[h.id] = {};
    for (const [g, sc] of Object.entries(run.ev[h.id].groups)) {
      if (!sc) continue;
      const champ = run.initialChampions[g]?.[h.id]?.model || 'M1';
      const best = CANDS.map((M) => ({ M, skill: sc.models[M].skill, pBetter: sc.models[M].pBetter })).sort((a, b) => b.skill - a.skill)[0];
      out[h.id][g] = { champion: champ, best, ece: sc.models[champ].ece, coverage: sc.coverage, tailSkill: sc.tail?.skill ?? null };
    }
  }
  return out;
}

self.onmessage = async (ev) => {
  const { base, override, today } = ev.data;
  const t0 = Date.now();
  try {
    self.postMessage({ type: 'progress', text: 'Đang tải số liệu thô…' });
    const r = await fetch('data/raw.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`data/raw.json: HTTP ${r.status}`);
    const raw = await r.json();
    self.postMessage({ type: 'progress', text: 'Đang kiểm định cấu hình hiện hành…' });
    const cur = runEngine(raw, { today, config: base });
    self.postMessage({ type: 'progress', text: 'Đang kiểm định cấu hình thử…' });
    const cand = runEngine(raw, { today, config: mergeConfig(base, override) });
    self.postMessage({ type: 'result', result: { current: summarize(cur), candidate: summarize(cand), ms: Date.now() - t0 } });
  } catch (e) {
    self.postMessage({ type: 'error', error: e.message || String(e) });
  }
};
