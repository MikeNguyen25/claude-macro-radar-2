#!/usr/bin/env node
// Runner của macro-radar 2.
//
// Phần tất định chạy trên GitHub Actions, trạng thái nằm trong repo (state/), lịch sử git là nhật ký
// bất biến có dấu thời gian:
//   node tools/mrc.mjs daily    --data data --state state --site site [--today D] [--force] [--weekly] [--monthly]
//   node tools/mrc.mjs rollback --state state --to 2.0.1
//   node tools/mrc.mjs propose  --state state --title "..." --override '{"params":{"tDof":7}}' [--hypothesis "..."]
//
// Tác vụ 07:40 của Claude chỉ thêm lớp AI (M6), chấm M6, đăng file và ghi vài doc DB nhỏ:
//   node tools/mrc.mjs status   --state state --site site [--manual dir]
//   node tools/mrc.mjs ai       --data data --state state --site site --out out [--ai analysis.json]
//                               [--due ai_due.json] [--aiscores scores_ai.json] [--manual dir] [--versions versions.json]
//   node tools/mrc.mjs manual   --id vn_cpi --period 2026-10 --value 3,2 --src1 "Tên|url" [--src2 "Tên|url"] [--doc cur.json] --out out
//   node tools/mrc.mjs raw      --data data --out out/files/data/raw.json
//
// Doc DB do tác vụ đọc lưu thành file JSON {"version": n, "data": {...}} hoặc chỉ phần data.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as E from '../src/engine/index.mjs';
import { validateAi, analysisDoc, verifyAnalysisDoc, aiBadge, AI_MAX_DEV } from '../src/engine/ai.mjs';
import { MANUAL_SERIES, manualDue } from '../src/engine/manual.mjs';

export { validateAi, analysisDoc, verifyAnalysisDoc, aiBadge, MANUAL_SERIES, manualDue };

export const INITIAL_VERSION = '2.0.0';
/** File giao diện đóng gói trong web/, đăng cạnh trang (index.html là file_path của lần đăng). */
export const WEB_FILES = ['app.js', 'app.css', 'sandbox-worker.js'];
export const REPO = 'MikeNguyen25/claude-macro-radar-2';
const PENDING_KEEP_DAYS = 120;   // bỏ ngày chờ chấm cũ hơn chừng này
const LEDGER_LIST_KEEP = 400;    // số ngày sổ dự báo liệt kê trong status và bundle
const HISTORY_OOS_MONTHS = 36;   // số tháng dự báo kiểm định gửi cho trang

// ------------------------------------------------------------------ tiện ích

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
function writeJson(f, v, pretty = false) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, pretty ? 1 : 0) + '\n');
}
const clone = (x) => (x === undefined || x === null ? x : structuredClone(x));
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
/** Ngày hiện tại theo giờ Việt Nam (UTC+7). */
export const vnToday = (ms = Date.now()) => new Date(ms + 7 * 3600e3).toISOString().slice(0, 10);
/** Thứ trong tuần của ngày ISO: 0 = Chủ nhật. */
export const weekday = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const r4 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

/** Doc DB đọc từ file: chấp nhận {"version", "data"} hoặc doc trần. */
export function readDbFile(f) {
  if (!f || f === true || !fs.existsSync(f)) return { version: null, data: null };
  const v = readJson(f);
  if (v && typeof v === 'object' && !Array.isArray(v) && 'data' in v && Object.keys(v).every((k) => ['data', 'version', 'exists', 'updatedAt'].includes(k))) {
    return { version: v.version ?? null, data: v.data };
  }
  return { version: null, data: v };
}

// ------------------------------------------------------------------ trạng thái trong repo

/** Đọc state/<collection>/<id>.json thành { 'collection/id': doc }. */
export function loadState(dir) {
  const out = {};
  if (!dir || !fs.existsSync(dir)) return out;
  for (const col of fs.readdirSync(dir).sort()) {
    const cdir = path.join(dir, col);
    if (!fs.statSync(cdir).isDirectory()) continue;
    for (const f of fs.readdirSync(cdir).sort()) if (f.endsWith('.json')) out[`${col}/${f.slice(0, -5)}`] = readJson(path.join(cdir, f));
  }
  return out;
}

/** Ghi doc vào state/. Sổ dự báo chỉ thêm: không ghi đè doc forecasts/ đã có. */
export function saveState(dir, docs) {
  const written = [];
  for (const [key, v] of Object.entries(docs)) {
    const [col, id] = key.split('/');
    const f = path.join(dir, col, `${id}.json`);
    if (col === 'forecasts' && fs.existsSync(f)) {
      if (readJson(f).hash !== v.hash) throw new Error(`không ghi đè ${key}: sổ dự báo chỉ thêm, không sửa`);
      continue;
    }
    writeJson(f, v, true);
    written.push(key);
  }
  return written;
}

/** Tăng version: 'patch' hoặc 'minor'; bản rc thì tăng số rc. */
export function bumpVersion(v, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(v || INITIAL_VERSION);
  if (!m) return v;
  const [maj, min, pat, rc] = [+m[1], +m[2], +m[3], m[4] === undefined ? null : +m[4]];
  if (rc !== null) return `${maj}.${min}.${pat}-rc.${rc + 1}`;
  return kind === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}

/** So sánh hai version dạng a.b.c (bỏ qua hậu tố rc). */
export function cmpVersion(a, b) {
  const pa = String(a).split(/[.-]/).map(Number);
  const pb = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// ------------------------------------------------------------------ số liệu

export function loadData(dir) {
  const read = (sub) => {
    const d = path.join(dir, sub);
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort().map((f) => readJson(path.join(d, f))) : [];
  };
  const qaF = path.join(dir, 'qa', 'latest.json');
  const catF = path.join(dir, 'catalog.json');
  return {
    raw: { assets: read('prices'), series: read('series') },
    qa: fs.existsSync(qaF) ? readJson(qaF) : null,
    catalog: fs.existsSync(catF) ? readJson(catF) : null,
  };
}

const champObj = (registry) => (registry?.champion
  ? Object.fromEntries(Object.entries(registry.champion).map(([g, hs]) => [g, Object.fromEntries(Object.entries(hs).map(([h, m]) => [h, { model: m }]))]))
  : null);
const champPlain = (ch) => Object.fromEntries(Object.entries(ch).map(([g, hs]) => [g, Object.fromEntries(Object.entries(hs).map(([h, c]) => [h, c.model]))]));

// ------------------------------------------------------------------ daily (GitHub Actions)

/**
 * Một lần chạy hằng ngày: chấm dự báo tới hạn, hạ ngôi nếu cần, phép thử hằng tuần, quyết định hằng
 * tháng, dự báo hôm nay (ghi sổ bất biến) và dựng file cho trang.
 */
export function daily(o) {
  const today = o.today || vnToday();
  const T = E.toDay(today);
  const stateDir = o.state || 'state';
  const siteDir = o.site || 'site';
  const S = loadState(stateDir);
  if (S[`forecasts/${today}`] && !o.force) return { ok: true, today, skipped: 'đã có dự báo hôm nay (sổ dự báo ghi một lần mỗi ngày)' };

  const { raw, qa, catalog } = loadData(o.data || 'data');
  const status = clone(S['meta/status']) || { schemaVersion: E.SCHEMA_VERSION };
  const first = !S['config/current'];
  let version = status.version || INITIAL_VERSION;
  let config = clone(S['config/current']?.config) || {};
  let configVersion = S['config/current']?.configVersion || 1;
  const notes = [];
  const errors = [];
  const versionEvents = [];
  const docs = {};
  const prevSummary = S['scores/summary'] || null;

  let run = E.runEngine(raw, { today, config, champions: champObj(S['models/registry']), summary: prevSummary });
  if (first) config = { ...config, tail: run.cfg.tail };
  const registry = clone(S['models/registry']) || {
    schemaVersion: E.SCHEMA_VERSION, champion: champPlain(run.initialChampions), previous: {},
    reasons: Object.fromEntries(Object.entries(run.initialChampions).map(([g, hs]) => [g, Object.fromEntries(Object.entries(hs).map(([h, c]) => [h, c.reason]))])),
    history: [{ date: today, event: 'khởi tạo', champion: champPlain(run.initialChampions) }],
  };

  // ---- chấm dự báo tới hạn (mỗi kỳ hạn chấm riêng phần của nó) và điểm tạm 7 ngày
  status.pending ??= Object.fromEntries(E.HORIZONS.map((h) => [h.id, []]));
  const dueDocs = [];
  const p7Docs = [];
  const verified = new Map();
  const getDoc = (d) => {
    if (verified.has(d)) return verified.get(d);
    const doc = S[`forecasts/${d}`];
    let ok = null;
    if (!doc) errors.push(`thiếu forecasts/${d} trong sổ dự báo`);
    else if (!E.verifyForecastDoc(doc)) errors.push(`hash forecasts/${d} không khớp: bỏ qua, không chấm`);
    else ok = doc;
    verified.set(d, ok);
    return ok;
  };
  for (const h of E.HORIZONS) {
    for (const d of status.pending[h.id] || []) {
      if (E.toDay(d) + h.days > T) continue;
      const doc = getDoc(d);
      if (doc) dueDocs.push({ date: doc.date, items: doc.items.filter((it) => it.h === h.id) });
    }
  }
  for (const d of status.p7Pending || []) if (E.toDay(d) + 7 <= T) { const doc = getDoc(d); if (doc) p7Docs.push(doc); }
  const { scored, waiting } = E.scoreMatured(dueDocs, run.data, T);
  const p7s = p7Docs.flatMap((d) => E.scoreProvisional7(d, run.data));
  const summary = E.updateSummary(prevSummary, scored, p7s, today);
  for (const h of E.HORIZONS) {
    status.pending[h.id] = (status.pending[h.id] || []).filter((d) => E.toDay(d) + h.days > T || waiting.some((w) => w.fd === d && w.h === h.id));
  }
  status.p7Pending = (status.p7Pending || []).filter((d) => E.toDay(d) + 7 > T);
  if (scored.length || p7s.length) docs[`scores/${today}`] = { schemaVersion: E.SCHEMA_VERSION, date: today, matured: scored, provisional7: p7s };

  // ---- postmortem cho dự báo trượt
  const qaFlags = new Set((qa?.assets || []).filter((a) => a.check?.status === 'lệch' || a.stale || a.errors?.length).map((a) => a.id));
  const riskCache = new Map();
  const riskAt = (iso) => {
    if (!riskCache.has(iso)) riskCache.set(iso, E.regimeReport(run.data, E.toDay(iso), run.panel.cache).risk.state);
    return riskCache.get(iso);
  };
  const pms = E.postmortems(scored, { qaFlags, riskAt });
  for (const p of pms) docs[`postmortems/${p.id}`] = { schemaVersion: E.SCHEMA_VERSION, ...p, createdAt: today };

  // ---- hạ ngôi: nhà vô địch kém M1 trong 6 khoảng trực tiếp gần nhất với độ chắc ≥ 0,9
  for (const [g, hs] of Object.entries(registry.champion)) {
    for (const [h, M] of Object.entries(hs)) {
      if (M === 'M1') continue;
      const lv = E.liveSkill(summary, h, g, M, run.cfg.gates.demoteIntervals);
      if (lv.intervals >= run.cfg.gates.demoteIntervals && lv.pBetter !== null && 1 - lv.pBetter >= run.cfg.gates.demoteConfidence) {
        const back = registry.previous?.[g]?.[h] && registry.previous[g][h] !== M ? registry.previous[g][h] : 'M1';
        registry.champion[g][h] = back;
        registry.history.push({ date: today, event: 'hạ ngôi', group: g, h, from: M, to: back, reason: `kém M1 trong ${lv.intervals} khoảng trực tiếp gần nhất (độ chắc ${(1 - lv.pBetter).toFixed(2)})` });
        versionEvents.push({ kind: 'minor', type: 'demotion', text: `Hạ ngôi ${M} ở ${E.GROUP_NAMES[g]} ${h} về ${back}` });
      }
    }
  }

  // ---- phép thử hằng tuần (Chủ nhật, hoặc bù nếu lần trước đã quá 8 ngày)
  const experiments = Object.fromEntries(Object.entries(S).filter(([k]) => k.startsWith('experiments/')).map(([k, v]) => [k.slice(12), clone(v)]));
  if (first) for (const s of E.SEED_EXPERIMENTS) experiments[s.id] = { schemaVersion: E.SCHEMA_VERSION, ...s, status: 'proposed', createdAt: today, history: [{ date: today, status: 'proposed' }] };
  const changedExp = new Set(first ? E.SEED_EXPERIMENTS.map((s) => s.id) : []);
  const lastWeekly = status.lastWeekly ? E.toDay(status.lastWeekly) : null;
  const weekly = o.weekly === true || (o.weekly !== 'no' && status.lastWeekly !== today && (weekday(today) === 0 || (lastWeekly !== null && T - lastWeekly >= 8)));
  let trials = Object.values(experiments).filter((e) => e.status !== 'proposed').length;
  if (weekly) {
    status.lastWeekly = today;
    for (const exp of Object.values(experiments).filter((e) => e.status === 'proposed').sort((a, b) => a.id.localeCompare(b.id)).slice(0, 3)) {
      try {
        const r = E.runExperiment(run.data, run.cfg, run.panel, exp, run.champions, run.ev, trials);
        trials++;
        experiments[exp.id] = { ...exp, status: r.status, testedAt: today, result: r, history: [...(exp.history || []), { date: today, status: r.status, reason: r.reason }] };
        changedExp.add(exp.id);
        notes.push(`Phép thử ${exp.id} (${exp.title}): ${r.status === 'shadow' ? 'qua cửa kiểm định, chạy song song (shadow)' : 'trượt'}.`);
      } catch (e) { errors.push(`phép thử ${exp.id} lỗi: ${e.message}`); }
    }
  }

  // ---- quyết định hằng tháng (lần chạy đầu tiên của tháng mới)
  const month = today.slice(0, 7);
  const monthly = o.monthly === true || (o.monthly !== 'no' && !!status.lastMonthly && status.lastMonthly !== month);
  let optimizeResult = null;
  if (first) status.lastMonthly = month;
  if (monthly) {
    status.lastMonthly = month;
    // (a) phép thử đang shadow: đủ khoảng trực tiếp và không kém nhà vô địch thì lên ngôi
    for (const exp of Object.values(experiments).filter((e) => e.status === 'shadow')) {
      for (const pass of exp.result?.passed || []) {
        const champ = registry.champion[pass.g]?.[pass.h] || 'M1';
        const lv = E.liveSkill(summary, pass.h, pass.g, `X:${exp.id}:${pass.model}`);
        const lc = E.liveSkill(summary, pass.h, pass.g, champ);
        const det = exp.result.details?.[pass.g]?.[pass.h];
        const ok = lv.intervals >= run.cfg.gates.liveIntervals && lv.skill !== null && (lc.skill === null || lv.skill >= lc.skill)
          && det && det.coverage >= run.cfg.gates.coverage[0] && det.coverage <= run.cfg.gates.coverage[1];
        if (!ok) continue;
        config = E.mergeConfig(config, exp.override);
        registry.previous[pass.g] = { ...(registry.previous[pass.g] || {}), [pass.h]: champ };
        registry.champion[pass.g][pass.h] = pass.model;
        registry.history.push({ date: today, event: 'lên ngôi', group: pass.g, h: pass.h, from: champ, to: pass.model, experiment: exp.id });
        versionEvents.push({ kind: 'minor', type: 'promotion', text: `Lên ngôi ${pass.model} (${exp.id}) ở ${E.GROUP_NAMES[pass.g]} ${pass.h}` });
        experiments[exp.id] = { ...experiments[exp.id], status: 'promoted', history: [...(exp.history || []), { date: today, status: 'promoted' }] };
        changedExp.add(exp.id);
      }
    }
    // (b) ứng viên sẵn có M2–M5 đủ cả ba cửa
    for (const pr of E.promotionsFromCandidates(run.ev, registry, (h, g, M) => E.liveSkill(summary, h, g, M), run.cfg, trials)) {
      registry.previous[pr.g] = { ...(registry.previous[pr.g] || {}), [pr.h]: pr.from };
      registry.champion[pr.g][pr.h] = pr.to;
      registry.history.push({ date: today, event: 'lên ngôi', group: pr.g, h: pr.h, from: pr.from, to: pr.to, reason: pr.reason });
      versionEvents.push({ kind: 'minor', type: 'promotion', text: `Lên ngôi ${pr.to} ở ${E.GROUP_NAMES[pr.g]} ${pr.h}` });
    }
    // (c) tối ưu tham số an toàn
    try {
      optimizeResult = E.optimize(run.data, run.cfg, run.panel);
      if (optimizeResult.accepted) {
        config = { ...config, params: { ...(config.params || {}), ...Object.fromEntries(optimizeResult.changes.map((c) => [c.key, c.to])) } };
        versionEvents.push({ kind: 'patch', type: 'config', text: `Tối ưu ${optimizeResult.changes.length} tham số (${optimizeResult.changes.map((c) => `${c.key} ${c.from}→${c.to}`).join(', ')})` });
      } else notes.push(`Tối ưu tham số: giữ nguyên (${optimizeResult.reason}).`);
    } catch (e) { errors.push(`tối ưu lỗi: ${e.message}`); }
    // (d) giả thuyết mới từ postmortem trong khoảng 35 ngày gần nhất
    const since = E.fromDay(T - 35);
    const recentPms = Object.entries(S).filter(([k]) => k.startsWith('postmortems/')).map(([, v]) => v).concat(pms).filter((p) => (p.end || p.fd || '') >= since);
    for (const hyp of E.hypothesesFromPostmortems(recentPms, month, Object.values(experiments))) {
      experiments[hyp.id] = { schemaVersion: E.SCHEMA_VERSION, ...hyp, createdAt: today, history: [{ date: today, status: 'proposed' }] };
      changedExp.add(hyp.id);
    }
    docs[`reviews/monthly-${month}`] = monthlyReview({ run, registry, summary, experiments, pms: recentPms, qa, month, today, version, optimizeResult });
    notes.push(`Đánh giá tháng ${month} đã ghi (state/reviews/monthly-${month}.json).`);
  }
  for (const id of changedExp) docs[`experiments/${id}`] = experiments[id];

  // ---- cấu hình hoặc nhà vô địch đổi: tăng version và chạy lại để dự báo hôm nay theo bản mới
  const prevVersion = version;
  for (const ev of versionEvents) version = bumpVersion(version, ev.kind);
  const configChanged = versionEvents.some((e) => e.type === 'config' || e.type === 'promotion');
  if (configChanged) configVersion += 1;
  if (versionEvents.length) run = E.runEngine(raw, { today, config, champions: champObj(registry), summary });

  // ---- shadow: dự báo song song của phép thử đang chạy shadow, ghi vào sổ để chấm trực tiếp
  const shadowIds = [];
  for (const exp of Object.values(experiments).filter((e) => e.status === 'shadow')) {
    try {
      const r = E.runEngine(raw, { today, config: E.mergeConfig(config, exp.override), champions: champObj(registry) });
      const byKey = new Map(r.live.items.map((it) => [`${it.a}|${it.h}`, it]));
      for (const it of run.live.items) {
        const sh = byKey.get(`${it.a}|${it.h}`);
        for (const p of (exp.result?.passed || []).filter((x) => x.g === it.g && x.h === it.h)) {
          if (sh && Number.isFinite(sh.p[p.model])) it.p[`X:${exp.id}:${p.model}`] = r4(sh.p[p.model]);
        }
      }
      shadowIds.push(exp.id);
    } catch (e) { errors.push(`shadow ${exp.id} lỗi: ${e.message}`); }
  }

  // ---- sổ dự báo hôm nay (bất biến, có hash)
  const createdAt = nowIso();
  const fdoc = E.forecastDoc(run.live, { configVersion, version, createdAt, ai: null, shadow: shadowIds });
  docs[`forecasts/${today}`] = fdoc;

  // ---- version, cấu hình, nhà vô địch, tóm tắt, trạng thái
  const cfgOut = { schemaVersion: E.SCHEMA_VERSION, configVersion, updatedAt: configChanged || first ? today : S['config/current']?.updatedAt || today, config: { ...config, tail: run.cfg.tail } };
  docs['config/current'] = cfgOut;
  if (first || configChanged) docs[`config/v${configVersion}`] = cfgOut;
  docs['models/registry'] = { ...registry, updatedAt: today };
  docs['scores/summary'] = summary;
  if (first || versionEvents.length) {
    docs[`versions/${version}`] = {
      schemaVersion: E.SCHEMA_VERSION, version, date: today, from: first ? null : prevVersion,
      events: first ? [{ kind: 'init', type: 'init', text: 'Khởi tạo macro-radar 2: M1 làm nhà vô địch ở nơi chưa ứng viên nào qua cửa kiểm định.' }] : versionEvents,
      snapshot: { config: cfgOut.config, configVersion, champion: registry.champion }, metrics: evalSummary(run),
    };
  }
  status.schemaVersion = E.SCHEMA_VERSION;
  status.version = version;
  status.engineVersion = E.ENGINE_VERSION;
  status.lastRun = { date: today, at: createdAt, ms: run.ms, scored: scored.length, p7: p7s.length, waiting: waiting.length, weekly, monthly, errors, notes };
  for (const h of E.HORIZONS) status.pending[h.id] = [...new Set([...(status.pending[h.id] || []), today])].filter((d) => E.toDay(d) >= T - PENDING_KEEP_DAYS).sort();
  status.p7Pending = [...new Set([...(status.p7Pending || []), today])].sort();
  status.ledger = [...(status.ledger || []).filter((x) => x.date !== today), { date: today, hash: fdoc.hash, version, configVersion }].slice(-LEDGER_LIST_KEEP);
  status.dataAsOf = Object.fromEntries(run.live.items.filter((i) => i.h === '1m').map((i) => [i.a, i.pd]));
  status.qaIssues = qa?.issues || [];
  docs['meta/status'] = status;

  const written = saveState(stateDir, docs);

  // ---- file cho trang và cho tác vụ AI
  const site = buildSite(run, { S: { ...S, ...docs }, qa, catalog, version, today, createdAt, notes, errors, versionEvents });
  writeJson(path.join(siteDir, 'bundle.json'), site.core);
  writeJson(path.join(siteDir, 'history.json'), site.history);
  writeJson(path.join(siteDir, 'latest.json'), site.latest);
  writeJson(path.join(siteDir, 'ai_context.json'), site.aiContext, true);
  return {
    ok: errors.length === 0, today, version, engineMs: run.ms, items: run.live.items.length, missing: run.live.missing, hash: fdoc.hash,
    scored: scored.length, p7: p7s.length, waiting: waiting.length, postmortems: pms.length, weekly, monthly,
    versionEvents: versionEvents.map((e) => e.text), notes, errors, written: written.length,
  };
}

/** Điểm kiểm định của nhà vô địch theo nhóm và kỳ hạn (ghi vào version và đánh giá tháng). */
export function evalSummary(run) {
  return Object.fromEntries(E.HORIZONS.map((h) => [h.id, Object.fromEntries(Object.entries(run.ev[h.id].groups).map(([g, sc]) => {
    const M = run.champions[g]?.[h.id]?.model || 'M1';
    return [g, sc && { champion: M, brier: sc.models[M].brier, skill: sc.models[M].skill, pBetter: sc.models[M].pBetter, ece: sc.models[M].ece, coverage: sc.coverage, tailSkill: sc.tail?.skill ?? null }];
  }))]));
}

function monthlyReview({ run, registry, summary, experiments, pms, qa, month, today, version, optimizeResult }) {
  return {
    schemaVersion: E.SCHEMA_VERSION, month, date: today, version,
    backtest: evalSummary(run),
    live: Object.fromEntries(E.HORIZONS.map((h) => [h.id, Object.fromEntries(run.data.groups.map((g) => [g, E.liveSkill(summary, h.id, g, registry.champion[g]?.[h.id] || 'M1')]))])),
    champion: registry.champion,
    postmortems: pms.map((p) => ({ id: p.id, cause: p.cause, causeLabel: p.causeLabel, assets: p.assets })),
    experiments: Object.values(experiments).map((e) => ({ id: e.id, title: e.title, status: e.status, reason: e.result?.reason || null })),
    optimize: optimizeResult ? { accepted: optimizeResult.accepted, reason: optimizeResult.reason, changes: optimizeResult.changes } : null,
    qaIssues: qa?.issues || [],
    next: Object.values(experiments).filter((e) => e.status === 'proposed').map((e) => `${e.id}: ${e.title}`),
  };
}

// ------------------------------------------------------------------ file cho trang

/** Ba biến động phiên gần nhất lớn nhất, đo bằng độ lệch chuẩn của chính tài sản. */
export function topMoves(run, n = 3) {
  const out = [];
  for (const A of run.data.forecastAssets) {
    const k = A.vals.length;
    if (k < 300) continue;
    const ch = A.kind === 'price' ? A.vals[k - 1] / A.vals[k - 2] - 1 : A.vals[k - 1] - A.vals[k - 2];
    let s = 0; let m = 0;
    for (let i = k - 252; i < k; i++) if (Number.isFinite(A.ret[i])) { s += A.ret[i] ** 2; m++; }
    const sd = Math.sqrt(s / Math.max(m, 1));
    out.push({ id: A.id, name: A.name, kind: A.kind, date: A.dates[k - 1], ch: r4(ch), z: sd > 0 ? r4(Math.abs(A.ret[k - 1]) / sd) : 0 });
  }
  return out.sort((a, b) => b.z - a.z).slice(0, n);
}

/** Kỹ năng trực tiếp theo kỳ hạn, nhóm và mô hình (từ tóm tắt sổ dự báo). */
export function liveStats(summary, groups, registry) {
  const out = {};
  for (const h of E.HORIZONS) {
    out[h.id] = {};
    for (const g of groups) {
      const cum = summary?.cum?.[`${h.id}|${g}`];
      const models = {};
      for (const M of new Set(['M1', 'M2', 'M3', 'M4', 'M5', ...Object.keys(cum?.models || {})])) {
        const lv = E.liveSkill(summary, h.id, g, M);
        const c = cum?.models?.[M];
        models[M] = { ...lv, n: c ? c[2] : 0, brier: c && c[2] ? r4(c[0] / c[2]) : null };
      }
      out[h.id][g] = { champion: registry?.champion?.[g]?.[h.id] || 'M1', models, band: cum ? { inBand: cum.band[0], n: cum.band[1] } : null,
        tail: cum && cum.tail[2] ? { brier: r4(cum.tail[0] / cum.tail[2]), base: r4(cum.tail[1] / cum.tail[2]), n: cum.tail[2] } : null,
        p7: summary?.p7?.[`${h.id}|${g}`] || null };
    }
  }
  return out;
}

/** Dựng bundle (lõi), history (lịch sử nặng), latest (hợp đồng) và ngữ cảnh AI. */
export function buildSite(run, ctx) {
  const { S, qa, catalog, version, today, createdAt } = ctx;
  const full = E.buildBundle(run, { qa, catalog, version, generatedAt: createdAt });
  const history = {
    schemaVersion: E.SCHEMA_VERSION, date: today,
    assets: full.assets.map((a) => ({ id: a.id, d: a.d, c: a.c, md: a.md, mc: a.mc })),
    series: full.series.map((s) => ({ id: s.id, hist: s.hist })),
    oos: Object.fromEntries(Object.entries(full.oos).map(([h, recs]) => {
      const keep = new Set([...new Set(recs.map((r) => r.d))].sort().slice(-HISTORY_OOS_MONTHS));
      return [h, recs.filter((r) => keep.has(r.d))];
    })),
  };
  const core = { ...full };
  delete core.oos;
  core.assets = full.assets.map(({ d, c, md, mc, ...rest }) => ({ ...rest, nDaily: d.length }));
  core.series = full.series.map(({ hist, ...rest }) => rest);
  const registry = S['models/registry'];
  const summary = S['scores/summary'];
  const status = S['meta/status'];
  const list = (prefix) => Object.entries(S).filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
  core.registry = registry;
  core.status = { version: status.version, lastRun: status.lastRun, ledger: status.ledger, pending: status.pending, lastWeekly: status.lastWeekly, lastMonthly: status.lastMonthly, qaIssues: status.qaIssues };
  core.liveStats = liveStats(summary, run.data.groups, registry);
  core.summaryInfo = { updated: summary?.updated || null, intervals: Object.fromEntries(E.HORIZONS.map((h) => [h.id, (summary?.intervals?.[h.id] || []).map((x) => x.fd)])) };
  core.versions = list('versions/').sort((a, b) => cmpVersion(b.version, a.version)).map((v) => ({ version: v.version, date: v.date, from: v.from, events: v.events, metrics: v.metrics }));
  core.experiments = list('experiments/').sort((a, b) => a.id.localeCompare(b.id)).map((e) => ({
    id: e.id, title: e.title, hypothesis: e.hypothesis, status: e.status, override: e.override, createdAt: e.createdAt, testedAt: e.testedAt || null,
    reason: e.result?.reason || null, threshold: e.result?.threshold ?? null, passed: e.result?.passed || [], details: e.result?.details || null, history: e.history }));
  core.postmortems = list('postmortems/').sort((a, b) => String(b.id).localeCompare(String(a.id))).slice(0, 60);
  core.reviews = list('reviews/').sort((a, b) => b.month.localeCompare(a.month)).slice(0, 6);
  core.recentScores = list('scores/').filter((x) => x.date && x.matured).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10)
    .map((x) => ({ date: x.date, matured: x.matured.map((m) => ({ fd: m.fd, a: m.a, g: m.g, h: m.h, champ: m.champ, p: m.models[m.champ]?.p ?? m.models.M1?.p, m1: m.models.M1?.p, y: m.y, ret: m.ret, inBand: m.inBand, tail: m.tail })) }));
  core.moves = topMoves(run);
  core.runNotes = { notes: ctx.notes || [], errors: ctx.errors || [], versionEvents: ctx.versionEvents || [] };
  core.ai = null;
  core.aiScores = null;
  core.manual = [];
  const latest = E.buildLatest(run, { version, generatedAt: createdAt, ai: null });
  core.aiContext = aiContext(run, { today, version, notes: ctx.notes || [], qa });
  return { core, history, latest, aiContext: core.aiContext };
}

/** Ngữ cảnh gọn (dưới 30 KB) để Claude viết nhận định AI. */
export function aiContext(run, { today, version, notes, qa }) {
  const chg = (A, days) => {
    const k = A.vals.length;
    const t1 = A.days[k - 1];
    let j = k - 1;
    while (j > 0 && A.days[j] > t1 - days) j--;
    return A.kind === 'price' ? r4(A.vals[k - 1] / A.vals[j] - 1) : r4(A.vals[k - 1] - A.vals[j]);
  };
  const items1 = run.live.items.filter((i) => i.h === '1m');
  const items3 = new Map(run.live.items.filter((i) => i.h === '3m').map((i) => [i.a, i]));
  const keySeries = ['us_cpi', 'us_pce_core', 'us_unrate', 'us_payems', 'us_icsa', 'us_ff', 'us_2y', 'us_10y', 'us_10y3m', 'us_nfci', 'us_baa10y', 'us_be5y',
    'cn_pmi', 'cn_cpi', 'cn_ppi', 'cn_lpr1y', 'cn_10y', 'cn_m2', 'vn_exports', 'vn_fx', 'w_cli_g20', 'w_ecb', 'w_boj'];
  const T = E.toDay(today);
  const macro = [];
  for (const id of keySeries) {
    const s = run.data.series.get(id);
    if (!s) continue;
    const k = s.raw.length - 1;
    macro.push({ id, name: s.name, unit: s.unit, period: s.dates[k], value: r4(s.raw[k]), transformed: Number.isFinite(s.x[k]) ? r4(s.x[k]) : null,
      transform: s.transform, published: E.fromDay(s.avail[k]), usable: s.avail[k] <= T, source: s.source?.name, url: s.source?.url });
  }
  return {
    instructions: {
      language: 'Tiếng Việt, ngắn gọn, đọc trên điện thoại. Không khuyến nghị mua bán.',
      schema: '{"headline": string, "regime": {"verdict": string, "title": string, "explain": string}, "regions": [{"id": "us|cn|world|vn", "view": string}], "assets": [{"id", "prob_up" (0–1, xác suất tăng sau 30 ngày), "view": "tang|giam|trung_lap", "confidence": "thap|vua|cao", "why", "bull", "bear", "evidence": [2–4 chuỗi, mỗi chuỗi có số, ngày và tên nguồn], "vs_model"}], "risks": [string], "watch": [string]}',
      rules: [
        `prob_up lệch tối đa ±${AI_MAX_DEV * 100} điểm % so với champion_prob; runner sẽ kẹp nếu vượt và ghi lại.`,
        'evidence: 2–4 dữ kiện kèm số, ngày và nguồn, lấy từ ngữ cảnh này hoặc trang đã mở trong phiên; ưu tiên điều mô hình chưa có như tin tức hay sự kiện có lịch.',
        'confidence chỉ là "cao" khi badge_1m của tài sản là strong và số liệu đồng thuận rõ; badge khác strong thì luôn là "thap".',
        'Không bịa số. Không có dữ kiện mới thì giữ prob_up bằng champion_prob và nói rõ.',
      ],
    },
    date: today, version,
    groupsBadges: Object.fromEntries(Object.entries(run.badges).map(([g, hs]) => [g, Object.fromEntries(Object.entries(hs).map(([h, b]) => [h, { champion: b.champion, badge: b.key, bss: b.skill, pBetter: b.pBetter }]))])),
    regime: { regions: run.regime.regions, risk: run.regime.risk },
    assets: items1.map((i) => {
      const A = run.data.assets.get(i.a);
      return {
        id: i.a, name: A.name, group: i.g, price: i.px, priceDate: i.pd, chg_1d: chg(A, 1), chg_7d: chg(A, 7), chg_30d: chg(A, 30),
        champion: i.champ, champion_prob: i.pc, base_m1: i.base, models: i.p, band80_1m: [r4(i.lo), r4(i.hi)], prob_tail_1m: i.pt, tail_k: i.k,
        prob_up_3m: items3.get(i.a)?.pc ?? null, badge_1m: i.badge,
      };
    }),
    macro, qaIssues: qa?.issues || [], notes,
  };
}

// ------------------------------------------------------------------ lớp AI (tác vụ Claude)

export const emptyAiScores = () => ({ schemaVersion: E.SCHEMA_VERSION, cum: {}, intervals: { '1m': [] }, lastInterval: {}, done: {}, updated: null });

/**
 * Chấm M6 (AI) cho nhận định đã tới hạn 30 ngày: so với M1 và nhà vô địch cùng ngày trong sổ dự báo.
 * @param {{date:string, probs:Record<string,number>}} due @param {object} fdoc @param {object} data @param {number} T
 */
export function scoreAi(due, fdoc, data, T) {
  if (!due || !fdoc) return [];
  const items = fdoc.items.filter((it) => it.h === '1m' && Number.isFinite(due.probs?.[it.a]))
    .map((it) => ({ ...it, m: { M6: due.probs[it.a], M1: it.m.M1, [it.champ]: it.m[it.champ] } }));
  return E.scoreMatured([{ date: fdoc.date, items }], data, T).scored;
}

/** Cộng điểm M6 vào tóm tắt (cùng cấu trúc với scores/summary để dùng chung liveSkill). */
export function updateAiScores(prev, scored, today) {
  const s = prev ? clone(prev) : emptyAiScores();
  s.intervals ??= { '1m': [] };
  s.intervals['1m'] ??= [];
  s.cum ??= {}; s.done ??= {}; s.lastInterval ??= {};
  const fresh = scored.filter((x) => !s.done[x.fd]);
  if (fresh.length) {
    const fd = fresh[0].fd;
    s.done[fd] = 1;
    const byG = {};
    for (const x of fresh) {
      const c = (s.cum[`1m|${x.g}`] ??= { models: {} });
      for (const [m, v] of Object.entries(x.models)) {
        const key = m === x.champ && m !== 'M1' ? 'champ' : m;
        const t = (c.models[key] ??= [0, 0, 0]);
        t[0] += v.b; t[1] += v.l; t[2] += 1;
        const u = ((byG[x.g] ??= {})[key] ??= [0, 0]);
        u[0] += v.b; u[1] += 1;
      }
    }
    const last = s.lastInterval['1m'];
    if (!last || E.toDay(fd) >= E.toDay(last) + 30) { s.lastInterval['1m'] = fd; s.intervals['1m'].push({ fd, g: byG }); }
  }
  const T = E.toDay(today);
  for (const k of Object.keys(s.done)) if (E.toDay(k) < T - 120) delete s.done[k];
  s.updated = today;
  return s;
}

function loadManualDir(dir) {
  if (!dir || dir === true || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => readDbFile(path.join(dir, f)).data).filter((d) => d && d.id);
}

/** Lệnh ai: thêm nhận định AI (M6), chấm M6, dựng file đăng và lệnh ghi DB. */
export function aiLayer(o) {
  const siteDir = o.site || 'site';
  const outDir = o.out || 'out';
  const core = readJson(path.join(siteDir, 'bundle.json'));
  const latest = readJson(path.join(siteDir, 'latest.json'));
  const today = core.date;
  const S = loadState(o.state || 'state');
  const fdoc = S[`forecasts/${today}`];
  if (!fdoc) throw new Error(`state chưa có forecasts/${today}`);
  if (!E.verifyForecastDoc(fdoc)) throw new Error(`hash forecasts/${today} không khớp`);
  const createdAt = nowIso();
  const aiRaw = o.ai && o.ai !== true && fs.existsSync(o.ai) ? readJson(o.ai) : null;
  const { ai, issues } = validateAi(aiRaw, core.live);
  const analysis = ai ? analysisDoc(ai, issues, { date: today, version: core.version, forecastHash: fdoc.hash, createdAt }) : null;

  // ---- chấm M6 tới hạn. Nguồn: file đã tải từ artifact (--prev: data/ai_scores.json, analyses/<ngày>.json)
  // hoặc file riêng (--aiscores, --due).
  const versions = readDbFile(o.versions).data || {};
  const prevDir = o.prev && o.prev !== true ? o.prev : null;
  const prevFile = (rel) => (prevDir && fs.existsSync(path.join(prevDir, rel)) ? path.join(prevDir, rel) : null);
  const prevScores = readDbFile(o.aiscores).data || (prevFile('data/ai_scores.json') ? readJson(prevFile('data/ai_scores.json')) : null);
  let aiScored = [];
  const notes = [];
  let due = o.due && o.due !== true && fs.existsSync(o.due) ? readDbFile(o.due).data : null;
  const dueDate = E.fromDay(E.toDay(today) - 30);
  if (!due && prevFile(`analyses/${dueDate}.json`)) {
    const doc = readJson(prevFile(`analyses/${dueDate}.json`));
    if (!verifyAnalysisDoc(doc)) notes.push(`hash analyses/${dueDate} không khớp: không chấm M6`);
    else due = { date: doc.date, hash: doc.hash, probs: Object.fromEntries((doc.assets || []).map((x) => [x.id, x.prob_up])) };
  }
  if (due) {
    const fd = S[`forecasts/${due.date}`];
    if (!due.date || !due.probs) notes.push('nhận định tới hạn thiếu date hoặc probs');
    else if (!fd) notes.push(`không có forecasts/${due.date} để chấm AI`);
    else if (E.toDay(due.date) + 30 > E.toDay(today)) notes.push(`nhận định ${due.date} chưa tới hạn`);
    else aiScored = scoreAi(due, fd, E.prepare(loadData(o.data || 'data').raw), E.toDay(today));
  }
  const aiScores = updateAiScores(prevScores, aiScored, today);
  const aiLive = {};
  for (const g of Object.keys(core.badges)) { const lv = E.liveSkill(aiScores, '1m', g, 'M6'); aiLive[g] = { ...lv, badge: aiBadge(lv) }; }
  const allLv = E.liveSkill(aiScores, '1m', null, 'M6');
  aiLive.all = { ...allLv, badge: aiBadge(allLv) };

  // ---- chuỗi nhập tay (chỉ hiển thị, không vào mô hình)
  const manual = loadManualDir(o.manual).map((m) => ({ id: m.id, name: m.name, unit: m.unit, region: m.region, factor: m.factor,
    last: m.d?.length ? { date: m.d[m.d.length - 1], value: m.v[m.v.length - 1], confidence: m.src?.[m.src.length - 1]?.confidence || null, sources: m.src?.[m.src.length - 1]?.sources || [] } : null,
    hist: { d: (m.d || []).slice(-36), v: (m.v || []).slice(-36) } }));

  // ---- file đăng lên artifact
  core.ai = ai ? { date: today, ...ai, validation: issues, hash: analysis.hash, createdAt } : null;
  core.aiScores = { live: aiLive, cum: aiScores.cum, intervals: aiScores.intervals['1m'].map((x) => x.fd),
    recent: aiScored.map((x) => ({ fd: x.fd, a: x.a, g: x.g, y: x.y, ret: x.ret, m6: x.models.M6?.p, m1: x.models.M1?.p })) };
  core.manual = manual;
  core.publishedAt = createdAt;
  latest.ai = ai ? { label: 'AI, chưa kiểm chứng', headline: ai.headline, regime: ai.regime, live: aiLive.all,
    assets: ai.assets.map((a) => ({ id: a.id, prob_up: a.prob_up, view: a.view, confidence: a.confidence })) } : null;
  latest.fields = { ...latest.fields, ai: 'Nhận định của Claude (M6): xác suất tăng 30 ngày, quan điểm, độ tự tin. Chỉ để tham khảo cho tới khi kỹ năng trực tiếp so với M1 đạt cửa kiểm chứng (live.badge).' };
  writeJson(path.join(outDir, 'files', 'data', 'bundle.json'), core);
  fs.mkdirSync(path.join(outDir, 'files', 'data'), { recursive: true });
  fs.copyFileSync(path.join(siteDir, 'history.json'), path.join(outDir, 'files', 'data', 'history.json'));
  writeJson(path.join(outDir, 'files', 'data', 'latest.json'), latest);
  writeJson(path.join(outDir, 'files', 'ledger', `${today}.json`), fdoc, true);
  writeJson(path.join(outDir, 'files', 'data', 'ai_scores.json'), aiScores);
  if (analysis) writeJson(path.join(outDir, 'files', 'analyses', `${today}.json`), analysis, true);

  // ---- lệnh ghi DB (doc nhỏ); doc đã có cần ifVersion
  const op = (p, data) => (versions[p] ? { op: 'set', path: p, ifVersion: versions[p], data } : { op: 'set', path: p, data });
  const ops = [];
  if (analysis) ops.push({ op: 'set', path: `analyses/${today}`, data: analysis });
  ops.push(op('scores/ai', aiScores));
  ops.push(op('public/latest', compactLatest(latest)));
  ops.push(op('meta/status', {
    schemaVersion: E.SCHEMA_VERSION, version: core.version, date: today, publishedAt: createdAt, forecastHash: fdoc.hash, analysisHash: analysis?.hash || null,
    aiIssues: issues, aiScored: aiScored.length, qaIssues: core.qa?.issues || [], actionsRun: core.status?.lastRun?.at || null,
  }));
  writeJson(path.join(outDir, 'db_ops.json'), ops);
  // Cho công cụ ArtifactData (phiên tự động): mỗi doc một file, gửi bằng file_path nên không phải chép số liệu.
  const writes = ops.map((x) => {
    const [collection, docId] = x.path.split('/');
    const f = path.resolve(outDir, 'db', `${collection}__${docId}.json`);
    writeJson(f, x.data);
    return { op: 'set', collection, doc_id: docId, file_path: f, ...(x.ifVersion ? { if_version: x.ifVersion } : {}) };
  });
  writeJson(path.join(outDir, 'db_writes.json'), writes, true);

  // ---- file đăng lên artifact: số liệu hôm nay, cộng trang và mã giao diện đã đóng gói trong repo (web/), nên giao
  // diện trên artifact luôn khớp commit đã qua CI. Chủ nhật (hoặc --raw) thêm số liệu thô cho bàn thử cấu hình.
  const files = Object.fromEntries(['data/bundle.json', 'data/history.json', 'data/latest.json', 'data/ai_scores.json', `ledger/${today}.json`,
    ...(analysis ? [`analyses/${today}.json`] : [])].map((f) => [f, path.resolve(outDir, 'files', f)]));
  const webDir = path.resolve(o.web && o.web !== true ? o.web : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web'));
  const page = fs.existsSync(path.join(webDir, 'index.html')) ? path.join(webDir, 'index.html') : null;
  if (page) {
    for (const f of WEB_FILES) if (fs.existsSync(path.join(webDir, f))) files[f] = path.join(webDir, f);
  } else notes.push(`không thấy ${webDir}/index.html: đăng bằng file trang mà Artifact read đã lưu`);
  if (o.raw === true || o.raw === 'yes' || weekday(today) === 0) {
    files['data/raw.json'] = rawBundle({ data: o.data || 'data', out: path.resolve(outDir, 'files', 'data', 'raw.json') }).file;
  }
  const message = dailyMessage(core, { ai, issues, aiScored, aiLive, S, today });
  fs.writeFileSync(path.join(outDir, 'message.txt'), `${message}\n`);
  return { ok: true, today, version: core.version, ops: ops.map((x) => `${x.path}${x.ifVersion ? ` (ifVersion ${x.ifVersion})` : ''}`), opBytes: JSON.stringify(ops).length,
    aiIssues: issues, aiScored: aiScored.length, aiDue: dueDate, notes, page, files, dbWrites: path.resolve(outDir, 'db_writes.json'), message };
}

/** public/latest trong DB: bản gọn (bỏ phần giải thích trường, làm tròn số). */
export function compactLatest(latest) {
  const { fields, ...rest } = latest;
  void fields;
  const rnd = (v) => (typeof v === 'number' ? (Math.abs(v) >= 100 ? Math.round(v * 100) / 100 : r4(v)) : v);
  return { ...rest, fieldsDoc: 'Giải thích từng trường: khóa fields trong data/latest.json của artifact.',
    assets: latest.assets.map((a) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, rnd(vv)])) : rnd(v)]))) };
}

const fmtPct = (x, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? '–' : `${(x * 100).toFixed(d).replace('.', ',')}%`);
const fmtNum = (x, d = 3) => (x === null || x === undefined || !Number.isFinite(x) ? '–' : x.toFixed(d).replace('.', ','));
const viDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** Tin nhắn hằng ngày cho Mike, tối đa 12 dòng. */
export function dailyMessage(core, { ai, issues, aiScored, aiLive, S, today }) {
  const L = [];
  const names = Object.fromEntries(core.assets.map((a) => [a.id, a.name]));
  L.push(`macro-radar 2 · ${viDate(today)}/${today.slice(0, 4)} · v${core.version}`);
  if (core.moves?.length) L.push(`Phiên gần nhất: ${core.moves.map((m) => `${m.name} ${m.ch >= 0 ? '+' : '−'}${m.kind === 'yield' ? `${Math.round(Math.abs(m.ch) * 100)} điểm cơ bản` : fmtPct(Math.abs(m.ch), 1)}`).join(', ')}.`);
  const us = core.regime.regions.us;
  L.push(`Kịch bản: Mỹ ${us.label.charAt(0).toLowerCase()}${us.label.slice(1)}; tâm lý thị trường ${core.regime.risk.label.toLowerCase()}.`);
  const calls = core.live.filter((i) => i.call !== 0);
  if (calls.length) L.push(`Nghiêng có cơ sở: ${calls.map((i) => `${names[i.a]} ${i.h === '1m' ? '1 tháng' : '3 tháng'} ${fmtPct(i.pc)} tăng (thường lệ ${fmtPct(i.base)})`).join('; ')}.`);
  const sk = [];
  for (const [g, hs] of Object.entries(core.badges)) for (const [h, b] of Object.entries(hs)) if (b.key === 'strong') sk.push(`${core.names.groups[g]} ${h === '1m' ? '1 tháng' : '3 tháng'}`);
  L.push(`Kỹ năng đã kiểm chứng: ${sk.length ? sk.join(', ') : 'chưa nhóm nào'}; nơi khác dùng tần suất lịch sử (M1).`);
  if (ai?.headline) L.push(`AI (chưa kiểm chứng): ${ai.headline}`);
  const sc = S[`scores/${today}`];
  const m1 = (sc?.matured || []).filter((x) => x.h === '1m');
  if (m1.length) {
    const right = m1.filter((x) => ((x.models[x.champ]?.p ?? 0.5) > 0.5) === (x.y === 1)).length;
    const bc = m1.reduce((s, x) => s + (x.models[x.champ]?.b ?? 0), 0) / m1.length;
    const b1 = m1.reduce((s, x) => s + (x.models.M1?.b ?? 0), 0) / m1.length;
    L.push(`Tới hạn 1 tháng (dự báo ${viDate(m1[0].fd)}): đúng hướng ${right}/${m1.length}; Brier ${fmtNum(bc)} so với M1 ${fmtNum(b1)}.`);
  } else L.push('Chưa có dự báo trực tiếp nào tới hạn (kỳ 1 tháng tới hạn 30 ngày sau lần chạy đầu).');
  if (aiScored.length) L.push(`AI tới hạn: ${aiScored.length} tài sản; tích lũy ${aiLive.all.intervals} khoảng, ${aiLive.all.badge.label.toLowerCase()}.`);
  const ev = core.runNotes?.versionEvents || [];
  if (ev.length) L.push(`Thay đổi: ${ev.map((e) => e.text).join('; ')} → v${core.version}.`);
  else if (core.runNotes?.notes?.length) {
    const exps = core.runNotes.notes.filter((n) => n.startsWith('Phép thử'));
    const rest = core.runNotes.notes.filter((n) => !n.startsWith('Phép thử'));
    if (exps.length) {
      const pass = exps.filter((n) => n.includes('qua cửa')).length;
      L.push(`Phép thử tuần này: ${exps.length} giả thuyết, ${pass} qua cửa kiểm định${pass ? ' (chạy song song)' : ''}, ${exps.length - pass} trượt.`);
    }
    if (rest.length) L.push(rest.slice(0, 1).join(' '));
  }
  const qaIssues = [...(core.qa?.issues || []), ...(core.runNotes?.errors || [])];
  if (qaIssues.length) L.push(`Sự cố số liệu: ${qaIssues.slice(0, 3).join('; ')}.`);
  if (issues?.length && ai) L.push(`Runner điều chỉnh nhận định AI ở ${issues.length} chỗ cho đúng luật.`);
  L.push('Công cụ tham khảo, không khuyến nghị mua bán.');
  while (L.length > 12) L.splice(L.length - 2, 1);
  return L.join('\n');
}

// ------------------------------------------------------------------ chuỗi nhập tay

export function manualEntry(o) {
  const def = MANUAL_SERIES.find((m) => m.id === o.id);
  if (!def) throw new Error(`không có chuỗi nhập tay ${o.id}`);
  const value = Number(String(o.value).replace(',', '.'));
  if (!Number.isFinite(value)) throw new Error('giá trị không hợp lệ');
  if (!/^\d{4}-\d{2}$/.test(o.period || '')) throw new Error('period phải dạng YYYY-MM');
  const parse = (s) => { if (!s || s === true) return null; const [name, url] = String(s).split('|'); return { name: name.trim(), url: (url || '').trim() }; };
  const sources = [parse(o.src1), parse(o.src2)].filter(Boolean);
  if (!sources.length) throw new Error('cần ít nhất một nguồn: --src1 "Tên|url"');
  const cur = readDbFile(o.doc);
  const doc = cur.data ? clone(cur.data) : { schemaVersion: E.SCHEMA_VERSION, id: def.id, name: def.name, region: def.region, factor: def.factor, unit: def.unit, freq: def.freq,
    source: { code: 'manual', name: 'Thông cáo chính thức (nhập tay)', url: '' }, d: [], v: [], src: [] };
  const date = `${o.period}-01`;
  const entry = { date, value, sources, confidence: sources.length >= 2 ? '2 nguồn' : '1 nguồn', recordedAt: nowIso() };
  const i = doc.d.indexOf(date);
  if (i >= 0) { if (doc.v[i] !== value) entry.revisedFrom = doc.v[i]; doc.v[i] = value; doc.src[i] = entry; }
  else {
    const k = doc.d.findIndex((x) => x > date);
    const at = k < 0 ? doc.d.length : k;
    doc.d.splice(at, 0, date); doc.v.splice(at, 0, value); doc.src.splice(at, 0, entry);
  }
  const p = `manual/${def.id}`;
  const out = o.out || 'out';
  const ops = [cur.version ? { op: 'set', path: p, ifVersion: cur.version, data: doc } : { op: 'set', path: p, data: doc }];
  writeJson(path.join(out, `manual_${def.id}.json`), ops);
  const docFile = path.resolve(out, 'db', `manual__${def.id}.json`);
  writeJson(docFile, doc);
  const writes = [{ op: 'set', collection: 'manual', doc_id: def.id, file_path: docFile, ...(cur.version ? { if_version: cur.version } : {}) }];
  writeJson(path.join(out, `manual_${def.id}.writes.json`), writes, true);
  return { ok: true, write: `manual_${def.id}.json`, writesForArtifactData: `manual_${def.id}.writes.json`, confidence: entry.confidence, revisedFrom: entry.revisedFrom ?? null };
}

// ------------------------------------------------------------------ status, rollback, propose, raw

export function statusReport(o) {
  const today = o.today || vnToday();
  const S = loadState(o.state || 'state');
  const st = S['meta/status'] || {};
  const siteF = path.join(o.site || 'site', 'bundle.json');
  const core = fs.existsSync(siteF) ? readJson(siteF) : null;
  const dueDate = E.fromDay(E.toDay(today) - 30);
  return {
    ok: !!S[`forecasts/${today}`] && core?.date === today, today, forecastReady: !!S[`forecasts/${today}`], siteDate: core?.date || null,
    version: st.version || null, lastRun: st.lastRun ? { at: st.lastRun.at, errors: st.lastRun.errors, weekly: st.lastRun.weekly, monthly: st.lastRun.monthly } : null,
    aiDue: S[`forecasts/${dueDate}`] ? dueDate : null, manualDue: manualDue(loadManualDir(o.manual), today), weekday: weekday(today), qaIssues: st.qaIssues || [],
  };
}

export function rollback(o) {
  const S = loadState(o.state || 'state');
  const v = S[`versions/${o.to}`];
  if (!v?.snapshot) throw new Error(`không có versions/${o.to} hoặc bản này không có snapshot`);
  const today = o.today || vnToday();
  const status = clone(S['meta/status']) || {};
  const cur = S['config/current'] || {};
  const version = bumpVersion(status.version || INITIAL_VERSION, 'patch');
  const configVersion = (cur.configVersion || 1) + 1;
  const cfgOut = { schemaVersion: E.SCHEMA_VERSION, configVersion, updatedAt: today, config: v.snapshot.config };
  const reg = clone(S['models/registry']) || { champion: {}, history: [] };
  reg.champion = clone(v.snapshot.champion);
  reg.history = [...(reg.history || []), { date: today, event: 'quay lại', to: o.to, version }];
  const from = status.version || null;
  status.version = version;
  saveState(o.state || 'state', {
    'config/current': cfgOut, [`config/v${configVersion}`]: cfgOut, 'models/registry': { ...reg, updatedAt: today },
    [`versions/${version}`]: { schemaVersion: E.SCHEMA_VERSION, version, date: today, from,
      events: [{ kind: 'patch', type: 'rollback', text: `Quay lại cấu hình và nhà vô địch của ${o.to}` }], snapshot: { ...v.snapshot, configVersion } },
    'meta/status': status,
  });
  return { ok: true, version, to: o.to, configVersion };
}

export function propose(o) {
  let override;
  try { override = JSON.parse(o.override); } catch { throw new Error('override phải là JSON hợp lệ'); }
  if (!override || typeof override !== 'object' || Array.isArray(override)) throw new Error('override phải là một object JSON');
  const allowed = new Set(['params', 'features', 'bandMethod', 'riskBandMultiplier', 'pool']);
  for (const k of Object.keys(override)) if (!allowed.has(k)) throw new Error(`không cho phép đổi khóa ${k} qua đề xuất`);
  for (const [k, val] of Object.entries(override.params || {})) {
    const spec = E.PARAM_SPECS.find((s) => s.key === k);
    if (!spec) throw new Error(`tham số lạ: ${k}`);
    if (!(val >= spec.hard[0] && val <= spec.hard[1])) throw new Error(`${k} = ${val} ngoài khoảng cứng ${spec.hard.join('–')}`);
  }
  const today = o.today || vnToday();
  const S = loadState(o.state || 'state');
  let n = 1;
  while (S[`experiments/exp-u${today.replace(/-/g, '')}-${n}`]) n++;
  const id = `exp-u${today.replace(/-/g, '')}-${n}`;
  saveState(o.state || 'state', { [`experiments/${id}`]: { schemaVersion: E.SCHEMA_VERSION, id, title: String(o.title || 'Đề xuất của Mike').slice(0, 120),
    hypothesis: String(o.hypothesis || '').slice(0, 500), override, status: 'proposed', createdAt: today, source: 'đề xuất từ trang', history: [{ date: today, status: 'proposed' }] } });
  return { ok: true, id };
}

/** Số liệu thô gọn cho bàn thử cấu hình trong trình duyệt. */
export function rawBundle(o) {
  const { raw } = loadData(o.data || 'data');
  const keepA = ['schemaVersion', 'id', 'name', 'group', 'kind', 'unit', 'forecast', 'source', 'quarantine', 'd', 'c'];
  const keepS = ['schemaVersion', 'id', 'name', 'region', 'factor', 'sign', 'transform', 'unit', 'freq', 'pubLagDays', 'source', 'periodEnd', 'd', 'v'];
  const pick = (x, keys) => Object.fromEntries(keys.filter((k) => k in x).map((k) => [k, x[k]]));
  const f = o.out || 'out/files/data/raw.json';
  writeJson(f, { schemaVersion: E.SCHEMA_VERSION, assets: raw.assets.map((a) => pick(a, keepA)), series: raw.series.map((s) => pick(s, keepS)) });
  return { ok: true, file: f, bytes: fs.statSync(f).size };
}

// ------------------------------------------------------------------ main

const COMMANDS = { daily, ai: aiLayer, status: statusReport, manual: manualEntry, rollback, propose, raw: rawBundle };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const o = parseArgs(process.argv.slice(2));
  const fn = COMMANDS[o._[0]];
  if (!fn) {
    console.log(`Dùng: node tools/mrc.mjs ${Object.keys(COMMANDS).join('|')} ... (xem đầu file)`);
    process.exitCode = o._[0] ? 1 : 0;
  } else {
    try {
      console.log(JSON.stringify(fn(o), null, 1));
    } catch (e) {
      console.error(JSON.stringify({ ok: false, error: e.message, stack: e.stack?.split('\n').slice(0, 5) }));
      process.exitCode = 1;
    }
  }
}
