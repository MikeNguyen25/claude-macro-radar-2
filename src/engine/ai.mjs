// Luật cho nhận định AI (M6), dùng chung cho runner (Node) và trang (trình duyệt).

import { SCHEMA_VERSION } from './config.mjs';
import { sha256, canonical } from './util.mjs';

/** AI lệch tối đa 10 điểm % so với xác suất của nhà vô địch. */
export const AI_MAX_DEV = 0.1;
const r4 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

/** Kiểm và kẹp nhận định AI theo luật của spec (mục 4.5). */
export function validateAi(ai, liveItems) {
  if (!ai) return { ai: null, issues: ['chưa có nhận định AI'] };
  const issues = [];
  const items1 = new Map(liveItems.filter((i) => i.h === '1m').map((i) => [i.a, i]));
  const str = (x, n = 600) => String(x ?? '').slice(0, n);
  const out = {
    headline: str(ai.headline, 300), regime: { verdict: str(ai.regime?.verdict, 60), title: str(ai.regime?.title, 120), explain: str(ai.regime?.explain, 800) },
    regions: (Array.isArray(ai.regions) ? ai.regions : []).slice(0, 6).map((r) => ({ id: str(r.id, 10), view: str(r.view, 400) })),
    assets: [], risks: (Array.isArray(ai.risks) ? ai.risks : []).slice(0, 6).map((x) => str(x, 300)),
    watch: (Array.isArray(ai.watch) ? ai.watch : []).slice(0, 6).map((x) => str(x, 300)),
  };
  const seen = new Set();
  for (const a of Array.isArray(ai.assets) ? ai.assets : []) {
    const it = items1.get(a.id);
    if (!it) { issues.push(`${a.id}: không có trong danh sách dự báo`); continue; }
    if (seen.has(a.id)) { issues.push(`${a.id}: trùng, bỏ bản sau`); continue; }
    seen.add(a.id);
    let p = Number(a.prob_up);
    if (!Number.isFinite(p)) { p = it.pc; issues.push(`${a.id}: prob_up không hợp lệ, dùng xác suất nhà vô địch`); }
    if (p > 1 && p <= 100) p /= 100;
    const lo = Math.max(0.05, it.pc - AI_MAX_DEV);
    const hi = Math.min(0.95, it.pc + AI_MAX_DEV);
    if (p < lo - 1e-9 || p > hi + 1e-9) { issues.push(`${a.id}: prob_up ${r4(p)} ngoài ±${AI_MAX_DEV * 100} điểm quanh ${it.pc}, đã kẹp`); p = Math.min(hi, Math.max(lo, p)); }
    let conf = ['thap', 'vua', 'cao'].includes(a.confidence) ? a.confidence : 'thap';
    if (it.badge !== 'strong' && conf !== 'thap') { issues.push(`${a.id}: nhóm chưa có cơ sở nên confidence là "thap"`); conf = 'thap'; }
    const evidence = (Array.isArray(a.evidence) ? a.evidence : []).slice(0, 4).map((x) => str(x, 300));
    if (evidence.length < 2) issues.push(`${a.id}: evidence dưới 2 dữ kiện`);
    const view = ['tang', 'giam', 'trung_lap'].includes(a.view) ? a.view : 'trung_lap';
    out.assets.push({ id: a.id, prob_up: Math.round(p * 1000) / 1000, view, confidence: conf, why: str(a.why), bull: str(a.bull), bear: str(a.bear),
      evidence, vs_model: str(a.vs_model, 300), champion_prob: it.pc, champion: it.champ });
  }
  for (const id of items1.keys()) if (!seen.has(id)) issues.push(`${id}: AI không nhận định`);
  return { ai: out, issues };
}

/** Doc nhận định AI có hash, gắn với hash sổ dự báo cùng ngày. */
export function analysisDoc(ai, issues, meta) {
  const body = { schemaVersion: SCHEMA_VERSION, date: meta.date, version: meta.version, forecastHash: meta.forecastHash, source: meta.source || 'tác vụ định kỳ', ...ai, validation: issues };
  return { ...body, createdAt: meta.createdAt, hash: sha256(canonical(body)) };
}

export function verifyAnalysisDoc(doc) {
  const { hash, createdAt, ...body } = doc;
  return sha256(canonical(body)) === hash;
}

/** Huy hiệu của AI theo kỹ năng trực tiếp so với M1. */
export function aiBadge(lv) {
  if (!lv || lv.intervals < 3 || lv.skill === null) return { key: 'none', label: 'Chưa đủ dữ liệu' };
  if (lv.skill > 0 && lv.pBetter >= 0.9) return { key: 'strong', label: 'Có cơ sở' };
  if (lv.skill > 0) return { key: 'weak', label: 'Ít cơ sở' };
  return { key: 'none', label: 'Chưa có cơ sở' };
}

