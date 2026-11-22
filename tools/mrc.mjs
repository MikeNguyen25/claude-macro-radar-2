#!/usr/bin/env node
// Runner của tác vụ định kỳ macro-radar 2. Tính toán nằm hết ở đây; Claude chỉ đọc/ghi DB,
// đăng file lên artifact, viết nhận định AI và gửi tin nhắn.
//
//   node tools/mrc.mjs fetch    --out data [--ref main]
//   node tools/mrc.mjs plan     --dump dump --today D
//   node tools/mrc.mjs run      --data data --dump dump --today D --out out [--optimize] [--experiments] [--monthly]
//   node tools/mrc.mjs finalize --out out [--ai analysis.json]
//   node tools/mrc.mjs manual   --dump dump --id vn_cpi --period 2026-10 --value 5.09 --src1 "Tên|url" [--src2 "Tên|url"] --out out
//   node tools/mrc.mjs rollback --dump dump --to 2.0.1 --out out
//
// Doc DB trong thư mục dump: mỗi doc một file <collection>__<id>.json dạng {"version": n, "data": {...}}.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'MikeNguyen25/claude-macro-radar-2';
const INITIAL_VERSION = '2.0.0-rc.1';
const MAX_OPS_PER_WRITE = 25;      // số doc mỗi lệnh db_write (giới hạn 50, chừa an toàn về kích thước)
const PENDING_KEEP_DAYS = 120;     // giữ danh sách ngày chờ chấm tối đa chừng này ngày
const LEDGER_DATES_KEEP = 800;     // số ngày sổ dự báo giữ trong meta/status

const E = await loadEngine();

async function loadEngine() {
  for (const rel of ['./engine.mjs', '../src/engine/index.mjs']) {
    const f = path.join(HERE, rel);
    if (fs.existsSync(f)) return import(pathToFileURL(f).href);
  }
  throw new Error('không tìm thấy engine (tools/engine.mjs hoặc src/engine/index.mjs)');
}

// ------------------------------------------------------------------ tiện ích

function args(argv) {
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
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const vnToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);

function curl(url) {
  return execFileSync('curl', ['-sfL', '--retry', '3', '--retry-delay', '3', '--max-time', '90', url], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
}

/** Đọc thư mục dump: { 'collection/id': {version, data} }. */
function loadDump(dir) {
  const out = {};
  if (!dir || !fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const key = f.slice(0, -5).replace('__', '/');
    const v = readJson(path.join(dir, f));
    out[key] = v && 'data' in v ? v : { version: undefined, data: v };
  }
  return out;
}

/** Lệnh ghi doc: có version thì kèm ifVersion (doc đã tồn tại). */
function setOp(dump, p, data) {
  const cur = dump[p];
  return cur && cur.version ? { op: 'set', path: p, ifVersion: cur.version, data } : { op: 'set', path: p, data };
}

/** Tăng version: 'patch' | 'minor'; bản rc thì tăng số rc. */
export function bumpVersion(v, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(v || INITIAL_VERSION);
  if (!m) return v;
  const [maj, min, pat, rc] = [+m[1], +m[2], +m[3], m[4] === undefined ? null : +m[4]];
  if (rc !== null) return `${maj}.${min}.${pat}-rc.${rc + 1}`;
  return kind === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}

const fmtPct = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '–' : `${(x * 100).toFixed(d).replace('.', ',')}%`);
const fmtNum = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '–' : x.toLocaleString('vi-VN', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const viDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// ------------------------------------------------------------------ chuỗi nhập tay (thông cáo Việt Nam)

/** Chuỗi Việt Nam không có API: đọc thông cáo, 2 nguồn khớp thì dùng, 1 nguồn thì ghi rõ. */
export const MANUAL_SERIES = [
  { id: 'vn_cpi', name: 'CPI Việt Nam (% so cùng kỳ)', region: 'vn', factor: 'inflation', sign: 1, transform: 'level', unit: '%', freq: 'M', pubLagDays: 7, releaseDay: 7,
    hint: 'Cục Thống kê (nso.gov.vn) công bố đầu tháng sau; lấy "CPI tháng X tăng ...% so với cùng kỳ năm trước".' },
  { id: 'vn_core_cpi', name: 'Lạm phát cơ bản Việt Nam (% so cùng kỳ)', region: 'vn', factor: 'inflation', sign: 1, transform: 'level', unit: '%', freq: 'M', pubLagDays: 7, releaseDay: 7,
    hint: 'Cùng thông cáo CPI của Cục Thống kê: "lạm phát cơ bản tháng X tăng ...% so với cùng kỳ".' },
  { id: 'vn_pmi', name: 'PMI sản xuất Việt Nam (S&P Global)', region: 'vn', factor: 'growth', sign: 1, transform: 'level50', unit: 'chỉ số', freq: 'M', pubLagDays: 3, releaseDay: 3,
    hint: 'S&P Global công bố ngày làm việc đầu tháng sau.' },
  { id: 'vn_refi', name: 'Lãi suất tái cấp vốn NHNN', region: 'vn', factor: 'policy', sign: 1, transform: 'chg6', unit: '%', freq: 'M', pubLagDays: 1, releaseDay: 2,
    hint: 'Ngân hàng Nhà nước (sbv.gov.vn); ghi mức đang áp dụng cuối tháng.' },
];

/** Chuỗi nhập tay đến hạn: kỳ mới nhất đáng lẽ đã công bố mà chưa có. */
function manualDue(manualDocs, today) {
  const [y, m, d] = today.split('-').map(Number);
  const due = [];
  for (const def of MANUAL_SERIES) {
    const doc = manualDocs.find((x) => x.id === def.id);
    const lastPeriod = doc?.d?.length ? doc.d[doc.d.length - 1].slice(0, 7) : null;
    let py = y; let pm = m - 1;
    if (d < def.releaseDay) pm -= 1;
    if (pm < 1) { pm += 12; py -= 1; }
    const expected = `${py}-${String(pm).padStart(2, '0')}`;
    if (!lastPeriod || lastPeriod < expected) due.push({ id: def.id, name: def.name, period: expected, hint: def.hint, last: lastPeriod });
  }
  return due;
}

// ------------------------------------------------------------------ lệnh fetch

function cmdFetch(o) {
  const ref = o.ref || 'main';
  const base = `https://raw.githubusercontent.com/${REPO}/${ref}/data/`;
  const out = o.out || 'data';
  const catalog = JSON.parse(curl(base + 'catalog.json'));
  writeJson(path.join(out, 'catalog.json'), catalog);
  let n = 0;
  for (const a of catalog.assets) { fs.mkdirSync(path.join(out, 'prices'), { recursive: true }); fs.writeFileSync(path.join(out, 'prices', `${a.id}.json`), curl(`${base}prices/${a.id}.json`)); n++; }
  for (const s of catalog.series) { fs.mkdirSync(path.join(out, 'series'), { recursive: true }); fs.writeFileSync(path.join(out, 'series', `${s.id}.json`), curl(`${base}series/${s.id}.json`)); n++; }
  try { fs.mkdirSync(path.join(out, 'qa'), { recursive: true }); fs.writeFileSync(path.join(out, 'qa', 'latest.json'), curl(base + 'qa/latest.json')); } catch { /* QA không bắt buộc */ }
  const last = catalog.assets.map((a) => `${a.id} ${a.last}`).join(', ');
  console.log(JSON.stringify({ ok: true, files: n, ref, lastPrices: last }));
}

// ------------------------------------------------------------------ lệnh plan

function cmdPlan(o) {
  const dump = loadDump(o.dump);
  const today = o.today || vnToday();
  const T = E.toDay(today);
  const st = dump['meta/status']?.data || {};
  const need = new Set();
  for (const h of E.HORIZONS) for (const d of st.pending?.[h.id] || []) if (E.toDay(d) + h.days <= T) need.add(d);
  for (const d of st.p7Pending || []) if (E.toDay(d) + 7 <= T) need.add(d);
  const docs = ['meta/status', 'config/current', 'models/registry', 'scores/summary', 'public/latest'];
  const out = {
    read: docs, list: ['experiments', 'manual'],
    forecasts: [...need].sort().map((d) => `forecasts/${d}`),
    note: 'Lưu mỗi doc vào dump/<collection>__<id>.json dạng {"version": n, "data": {...}}; doc chưa có thì bỏ qua.',
  };
  console.log(JSON.stringify(out, null, 1));
}

// ------------------------------------------------------------------ lệnh run

function loadData(dir, manualDocs) {
  const read = (sub) => (fs.existsSync(path.join(dir, sub)) ? fs.readdirSync(path.join(dir, sub)).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, sub, f))) : []);
  const qa = fs.existsSync(path.join(dir, 'qa', 'latest.json')) ? readJson(path.join(dir, 'qa', 'latest.json')) : null;
  const catalog = fs.existsSync(path.join(dir, 'catalog.json')) ? readJson(path.join(dir, 'catalog.json')) : null;
  const manual = manualDocs.map((m) => ({ ...m, manual: true }));
  return { raw: { assets: read('prices'), series: read('series'), manual }, qa, catalog };
}

function champObj(registry) {
  if (!registry?.champion) return null;
  return Object.fromEntries(Object.entries(registry.champion).map(([g, hs]) => [g, Object.fromEntries(Object.entries(hs).map(([h, m]) => [h, { model: m }]))]));
}

function champPlain(ch) {
  return Object.fromEntries(Object.entries(ch).map(([g, hs]) => [g, Object.fromEntries(Object.entries(hs).map(([h, c]) => [h, c.model]))]));
}

function cmdRun(o) {
  const today = o.today || vnToday();
  const T = E.toDay(today);
  const outDir = o.out || 'out';
  const dump = loadDump(o.dump);
  const manualDocs = Object.entries(dump).filter(([k]) => k.startsWith('manual/')).map(([, v]) => v.data);
  const { raw, qa, catalog } = loadData(o.data || 'data', manualDocs);
  const status = structuredClone(dump['meta/status']?.data || {});
  const version = status.version || INITIAL_VERSION;
  const cfgDoc = dump['config/current']?.data;
  const regDoc = dump['models/registry']?.data;
  let config = cfgDoc?.config || {};
  let configVersion = cfgDoc?.configVersion || 1;
  const first = !cfgDoc;
  const notes = [];
  const versionEvents = [];
  const writes = [];
  const errors = [];

  let run = E.runEngine(raw, { today, config, champions: champObj(regDoc), summary: dump['scores/summary']?.data });
  if (first || run.tailChosen) config = { ...config, tail: run.cfg.tail };
  let registry = regDoc ? structuredClone(regDoc) : {
    schemaVersion: E.SCHEMA_VERSION, champion: champPlain(run.initialChampions), previous: {},
    reasons: Object.fromEntries(Object.entries(run.initialChampions).map(([g, hs]) => [g, Object.fromEntries(Object.entries(hs).map(([h, c]) => [h, c.reason]))])),
    shadow: [], retired: [], history: [{ date: today, event: 'khởi tạo', champion: champPlain(run.initialChampions) }],
  };

  // ---- chấm dự báo tới hạn và điểm tạm 7 ngày
  const fdocs = Object.entries(dump).filter(([k]) => k.startsWith('forecasts/')).map(([, v]) => v.data);
  const tamper = fdocs.filter((d) => !E.verifyForecastDoc(d));
  if (tamper.length) errors.push(`hash sổ dự báo không khớp: ${tamper.map((d) => d.date).join(', ')} (không chấm các doc này)`);
  const okDocs = fdocs.filter((d) => E.verifyForecastDoc(d));
  const { scored, waiting } = E.scoreMatured(okDocs.filter((d) => (status.pending?.['1m'] || []).includes(d.date) || (status.pending?.['3m'] || []).includes(d.date)), run.data, T);
  const p7docs = okDocs.filter((d) => (status.p7Pending || []).includes(d.date) && E.toDay(d.date) + 7 <= T);
  const p7s = p7docs.flatMap((d) => E.scoreProvisional7(d, run.data));
  const summary = E.updateSummary(dump['scores/summary']?.data || null, scored, p7s, today);
  status.pending ??= { '1m': [], '3m': [] };
  for (const h of E.HORIZONS) {
    status.pending[h.id] = (status.pending[h.id] || []).filter((d) => {
      if (E.toDay(d) + h.days > T) return true; // chưa tới hạn
      const stillWaiting = waiting.some((w) => w.fd === d && w.h === h.id);
      return stillWaiting && E.toDay(d) + h.days + 10 >= T;
    });
  }
  status.p7Pending = (status.p7Pending || []).filter((d) => E.toDay(d) + 7 > T);

  // ---- postmortem
  const qaFlags = new Set((qa?.assets || []).filter((a) => a.quarantine?.length || a.check?.status === 'lệch' || a.stale).map((a) => a.id));
  const riskAt = (iso) => E.regimeReport(run.data, E.toDay(iso), run.panel.cache).risk.state;
  const pms = E.postmortems(scored, { qaFlags, riskAt });

  // ---- hạ ngôi tự động: nhà vô địch kém M1 trong 6 khoảng gần nhất với độ chắc ≥ 0,9
  for (const [g, hs] of Object.entries(registry.champion)) {
    for (const [h, M] of Object.entries(hs)) {
      if (M === 'M1') continue;
      const lv = E.liveSkill(summary, h, g, M, run.cfg.gates.demoteIntervals);
      if (lv.intervals >= run.cfg.gates.demoteIntervals && lv.pBetter !== null && 1 - lv.pBetter >= run.cfg.gates.demoteConfidence) {
        const back = registry.previous?.[g]?.[h] || 'M1';
        registry.champion[g][h] = back;
        registry.history.push({ date: today, event: 'hạ ngôi', group: g, h, from: M, to: back, reason: `kém M1 trong ${lv.intervals} khoảng gần nhất (độ chắc ${(1 - lv.pBetter).toFixed(2)})` });
        versionEvents.push({ kind: 'minor', type: 'demotion', text: `Hạ ngôi ${M} ở ${g} ${h} về ${back}` });
      }
    }
  }

  // ---- tối ưu tham số an toàn
  let optimizeResult = null;
  if (o.optimize) {
    try {
      optimizeResult = E.optimize(run.data, run.cfg, run.panel);
      if (optimizeResult.accepted) {
        config = { ...config, params: { ...(config.params || {}), ...Object.fromEntries(optimizeResult.changes.map((c) => [c.key, c.to])) } };
        versionEvents.push({ kind: 'patch', type: 'config', text: `Tối ưu ${optimizeResult.changes.length} tham số`, changes: optimizeResult.changes, pBetter: optimizeResult.pBetter });
      }
    } catch (e) { errors.push(`tối ưu lỗi: ${e.message}`); }
  }

  // ---- phép thử hằng tuần
  const expDocs = Object.entries(dump).filter(([k]) => k.startsWith('experiments/')).map(([, v]) => v.data);
  const expWrites = [];
  if (first) for (const s of E.SEED_EXPERIMENTS) expWrites.push({ ...s, status: 'proposed', createdAt: today, history: [{ date: today, status: 'proposed' }] });
  const trialsSoFar = expDocs.filter((e) => e.status !== 'proposed').length;
  if (o.experiments) {
    const proposed = [...expDocs, ...expWrites].filter((e) => e.status === 'proposed').slice(0, 3);
    let trials = trialsSoFar;
    for (const exp of proposed) {
      try {
        const r = E.runExperiment(run.data, run.cfg, run.panel, exp, run.champions, run.ev, trials);
        trials++;
        const upd = { ...exp, status: r.status, testedAt: today, result: r, history: [...(exp.history || []), { date: today, status: r.status, reason: r.reason }] };
        const idx = expWrites.findIndex((e) => e.id === exp.id);
        if (idx >= 0) expWrites[idx] = upd; else expWrites.push(upd);
        notes.push(`Phép thử ${exp.id}: ${r.status === 'shadow' ? 'qua cửa kiểm định, chạy shadow' : 'trượt'} (${r.reason})`);
      } catch (e) { errors.push(`phép thử ${exp.id} lỗi: ${e.message}`); }
    }
  }

  // ---- hằng tháng: xét lên ngôi, gom postmortem thành giả thuyết, đánh giá tháng
  let review = null;
  if (o.monthly) {
    const month = today.slice(0, 7);
    for (const exp of [...expDocs, ...expWrites].filter((e) => e.status === 'shadow')) {
      for (const pass of exp.result?.passed || []) {
        const lv = E.liveSkill(summary, pass.h, pass.g, `X:${exp.id}:${pass.model}`);
        const champ = registry.champion[pass.g]?.[pass.h] || 'M1';
        const lc = E.liveSkill(summary, pass.h, pass.g, champ);
        const det = exp.result.details?.[pass.g]?.[pass.h];
        const ok = lv.intervals >= run.cfg.gates.liveIntervals && lv.skill !== null && lc.skill !== null && lv.skill >= lc.skill
          && det && det.coverage >= run.cfg.gates.coverage[0] && det.coverage <= run.cfg.gates.coverage[1];
        if (ok) {
          config = E.mergeConfig ? E.mergeConfig(config, exp.override) : { ...config, ...exp.override };
          registry.previous[pass.g] = { ...(registry.previous[pass.g] || {}), [pass.h]: champ };
          registry.champion[pass.g][pass.h] = pass.model;
          registry.history.push({ date: today, event: 'lên ngôi', group: pass.g, h: pass.h, from: champ, to: pass.model, experiment: exp.id });
          versionEvents.push({ kind: 'minor', type: 'promotion', text: `Lên ngôi ${pass.model} (${exp.id}) ở ${pass.g} ${pass.h}` });
          expWrites.push({ ...exp, status: 'promoted', history: [...(exp.history || []), { date: today, status: 'promoted' }] });
        }
      }
    }
    for (const pr of E.promotionsFromCandidates(run.ev, registry, (h, g, M) => E.liveSkill(summary, h, g, M), run.cfg, trialsSoFar)) {
      registry.previous[pr.g] = { ...(registry.previous[pr.g] || {}), [pr.h]: pr.from };
      registry.champion[pr.g][pr.h] = pr.to;
      registry.history.push({ date: today, event: 'lên ngôi', group: pr.g, h: pr.h, from: pr.from, to: pr.to, reason: pr.reason });
      versionEvents.push({ kind: 'minor', type: 'promotion', text: `Lên ngôi ${pr.to} ở ${pr.g} ${pr.h} (${pr.reason})` });
    }
    const allPms = Object.entries(dump).filter(([k]) => k.startsWith('postmortems/')).map(([, v]) => v.data).concat(pms);
    const monthPms = allPms.filter((p) => (p.end || '').slice(0, 7) >= E.fromDay(T - 31).slice(0, 7));
    for (const hyp of E.hypothesesFromPostmortems(monthPms, month, [...expDocs, ...expWrites])) expWrites.push({ ...hyp, createdAt: today, history: [{ date: today, status: 'proposed' }] });
    review = {
      schemaVersion: E.SCHEMA_VERSION, month, date: today, version,
      backtest: Object.fromEntries(E.HORIZONS.map((h) => [h.id, Object.fromEntries(Object.entries(run.ev[h.id].groups).map(([g, sc]) => [g, sc && { skill: sc.models[registry.champion[g]?.[h.id] || 'M1'].skill, ece: sc.models[registry.champion[g]?.[h.id] || 'M1'].ece, coverage: sc.coverage }]))])),
      live: Object.fromEntries(E.HORIZONS.map((h) => [h.id, Object.fromEntries(run.data.groups.map((g) => [g, E.liveSkill(summary, h.id, g, registry.champion[g]?.[h.id] || 'M1')]))])),
      ai: Object.fromEntries(run.data.groups.map((g) => [g, E.liveSkill(summary, '1m', g, 'M6')])),
      postmortems: monthPms.map((p) => ({ id: p.id, cause: p.causeLabel, assets: p.assets })),
      experiments: [...expDocs, ...expWrites].map((e) => ({ id: e.id, status: e.status, title: e.title })),
      qaIssues: qa?.issues || [],
      next: 'Giả thuyết tháng tới: các phép thử ở trạng thái proposed trong experiments/.',
    };
    notes.push(`Đánh giá tháng ${month} đã ghi vào reviews/monthly-${month}.`);
  }

  // ---- cấu hình hoặc nhà vô địch đổi thì chạy lại engine để dự báo hôm nay theo bản mới
  let newVersion = version;
  for (const ev of versionEvents) newVersion = bumpVersion(newVersion, ev.kind);
  if (versionEvents.length) {
    configVersion += versionEvents.some((e) => e.type === 'config' || e.type === 'promotion') ? 1 : 0;
    run = E.runEngine(raw, { today, config, champions: champObj(registry), summary });
  }

  // ---- shadow: dự báo song song của phép thử đang shadow
  const shadow = [];
  for (const exp of [...expDocs, ...expWrites].filter((e) => e.status === 'shadow')) {
    try {
      const r = E.runEngine(raw, { today, config: E.mergeConfig(config, exp.override), champions: champObj(registry) });
      for (const it of r.live.items) {
        const passG = (exp.result?.passed || []).filter((p) => p.g === it.g && p.h === it.h);
        for (const p of passG) shadow.push({ exp: exp.id, a: it.a, h: it.h, model: `X:${exp.id}:${p.model}`, p: it.p[p.model] });
      }
    } catch (e) { errors.push(`shadow ${exp.id} lỗi: ${e.message}`); }
  }

  // ---- doc trạng thái
  const cfgOut = { schemaVersion: E.SCHEMA_VERSION, configVersion, updatedAt: today, config: { ...config, tail: run.cfg.tail } };
  status.version = newVersion;
  status.lastRun = { date: today, at: nowIso(), ms: run.ms, scored: scored.length, waiting: waiting.length, errors };
  status.ledgerDates = [...new Set([...(status.ledgerDates || []), today])].sort().slice(-LEDGER_DATES_KEEP);
  for (const h of E.HORIZONS) status.pending[h.id] = [...new Set([...(status.pending[h.id] || []), today])].filter((d) => E.toDay(d) >= T - PENDING_KEEP_DAYS).sort();
  status.p7Pending = [...new Set([...(status.p7Pending || []), today])].sort();
  status.dataAsOf = Object.fromEntries(run.live.items.filter((i) => i.h === '1m').map((i) => [i.a, i.pd]));
  status.qaIssues = qa?.issues || [];

  // ---- nội dung cho bước finalize
  const state = {
    today, version: newVersion, configVersion, first, live: run.live, champions: champPlain(run.champions), badges: run.badges,
    regime: run.regime, notes, errors, versionEvents, optimize: optimizeResult && { accepted: optimizeResult.accepted, changes: optimizeResult.changes, pBetter: optimizeResult.pBetter, reason: optimizeResult.reason },
    scoredToday: scored, p7Today: p7s, postmortems: pms, shadow, manualDue: manualDue(manualDocs, today), moves: topMoves(run),
    dumpVersions: Object.fromEntries(Object.entries(dump).map(([k, v]) => [k, v.version ?? null])),
    docs: {
      'config/current': cfgOut,
      'models/registry': { ...registry, updatedAt: today },
      'scores/summary': summary,
      'meta/status': status,
      ...(scored.length || p7s.length ? { [`scores/${today}`]: { schemaVersion: E.SCHEMA_VERSION, date: today, matured: scored, provisional7: p7s } } : {}),
      ...Object.fromEntries(pms.map((p) => [`postmortems/${p.id}`, { schemaVersion: E.SCHEMA_VERSION, ...p, createdAt: today }])),
      ...Object.fromEntries(expWrites.map((e) => [`experiments/${e.id}`, { schemaVersion: E.SCHEMA_VERSION, ...e }])),
      ...(review ? { [`reviews/monthly-${review.month}`]: review } : {}),
      ...(qa ? { [`qa/${today}`]: { schemaVersion: E.SCHEMA_VERSION, date: today, generatedAt: qa.generated_at, issues: qa.issues || [], revisions: qa.revisions ?? 0 } } : {}),
      ...(catalog ? { 'series/catalog': { schemaVersion: E.SCHEMA_VERSION, updatedAt: today, ...catalog } } : {}),
    },
    versionDocs: versionEvents.length ? [{ version: newVersion, date: today, events: versionEvents,
      snapshot: { config: cfgOut.config, champion: registry.champion }, metrics: summarizeEval(run) }] : [],
  };
  if (versionEvents.some((e) => e.type === 'config' || e.type === 'promotion')) state.docs[`config/v${configVersion}`] = cfgOut;
  fs.mkdirSync(outDir, { recursive: true });
  writeJson(path.join(outDir, 'state.json'), state);
  const bundle = E.buildBundle(run, { qa, catalog, version: newVersion, generatedAt: nowIso() });
  writeJson(path.join(outDir, 'bundle.pre.json'), bundle);
  writeJson(path.join(outDir, 'ai_context.json'), aiContext(run, state, raw), true);
  const ctxSize = fs.statSync(path.join(outDir, 'ai_context.json')).size;
  console.log(JSON.stringify({
    ok: errors.length === 0, today, version: newVersion, engineMs: run.ms, items: run.live.items.length, missing: run.live.missing,
    scored: scored.length, waiting: waiting.length, p7: p7s.length, postmortems: pms.length, versionEvents: versionEvents.map((e) => e.text),
    manualDue: state.manualDue.map((m) => `${m.id} ${m.period}`), aiContextBytes: ctxSize, errors, next: 'viết analysis.json theo ai_context.json rồi chạy finalize',
  }, null, 1));
}

/** Ba biến động phiên gần nhất lớn nhất (theo độ lệch chuẩn của chính tài sản). */
function topMoves(run) {
  const out = [];
  for (const A of run.data.forecastAssets) {
    const n = A.vals.length;
    if (n < 300) continue;
    const ch = A.kind === 'price' ? A.vals[n - 1] / A.vals[n - 2] - 1 : A.vals[n - 1] - A.vals[n - 2];
    let s = 0; let k = 0;
    for (let i = n - 252; i < n; i++) if (Number.isFinite(A.ret[i])) { s += A.ret[i] ** 2; k++; }
    const sd = Math.sqrt(s / Math.max(k, 1));
    out.push({ id: A.id, name: A.name, kind: A.kind, date: A.dates[n - 1], ch, z: sd > 0 ? Math.abs(A.ret[n - 1]) / sd : 0 });
  }
  return out.sort((a, b) => b.z - a.z).slice(0, 3);
}

function summarizeEval(run) {
  return Object.fromEntries(E.HORIZONS.map((h) => [h.id, Object.fromEntries(Object.entries(run.ev[h.id].groups).map(([g, sc]) => {
    const M = run.champions[g]?.[h.id]?.model || 'M1';
    return [g, sc && { champion: M, brier: sc.models[M].brier, skill: sc.models[M].skill, pBetter: sc.models[M].pBetter, ece: sc.models[M].ece, coverage: sc.coverage }];
  }))]));
}

/** Ngữ cảnh gọn (< 30 KB) cho nhận định AI. */
function aiContext(run, state, raw) {
  const pct = (a, d) => {
    const A = run.data.assets.get(a);
    if (!A) return null;
    const n = A.vals.length;
    const i0 = E.toDay(A.dates[n - 1]);
    let j = n - 1;
    while (j > 0 && E.toDay(A.dates[j]) > i0 - d) j--;
    return A.kind === 'price' ? A.vals[n - 1] / A.vals[j] - 1 : A.vals[n - 1] - A.vals[j];
  };
  const items1 = run.live.items.filter((i) => i.h === '1m');
  const items3 = new Map(run.live.items.filter((i) => i.h === '3m').map((i) => [i.a, i]));
  const keySeries = ['us_cpi', 'us_pce_core', 'us_unrate', 'us_payems', 'us_ff', 'us_2y', 'us_10y3m', 'us_nfci', 'us_baa10y', 'us_be5y', 'cn_pmi', 'cn_cpi', 'cn_ppi', 'cn_lpr1y', 'cn_10y', 'vn_exports', 'vn_fx', 'w_cli_g20', 'w_ecb'];
  const T = E.toDay(state.today);
  const macro = [];
  for (const id of keySeries) {
    const s = run.data.series.get(id);
    if (!s) continue;
    const k = s.raw.length - 1;
    macro.push({ id, name: s.name, date: s.dates[k], value: +s.raw[k].toFixed(4), x: Number.isFinite(s.x[k]) ? +s.x[k].toFixed(3) : null, transform: s.transform, source: s.source?.name, url: s.source?.url, published: E.fromDay(s.avail[k]) <= state.today });
  }
  for (const m of raw.manual || []) if (m.d?.length) macro.push({ id: m.id, name: m.name, date: m.d[m.d.length - 1], value: m.v[m.v.length - 1], source: 'nhập tay từ thông cáo', confidence: m.src?.[m.src.length - 1]?.confidence });
  return {
    instructions: {
      language: 'Tiếng Việt, ngắn gọn, đọc trên điện thoại.',
      schema: '{headline, regime:{verdict, title, explain}, regions:[{id, view}], assets:[{id, prob_up, view (tang|giam|trung_lap), confidence (thap|vua|cao), why, bull, bear, evidence:[2–4 dữ kiện có số và ngày], vs_model}], risks:[...], watch:[...]}',
      rules: [
        'prob_up là xác suất tăng sau 30 ngày; lệch tối đa ±10 điểm % so với champion_prob (runner sẽ kẹp nếu vượt).',
        'evidence: 2–4 dữ kiện kèm số và ngày, đọc được từ nguồn trong phiên (ngữ cảnh này hoặc trang đã mở); ưu tiên điều mô hình chưa có như tin tức, sự kiện có lịch.',
        'confidence chỉ được là cao khi badge của nhóm là strong và số liệu đồng thuận rõ; badge khác strong thì luôn là thap.',
        'Không bịa số, không khuyến nghị mua bán. Không có dữ kiện thì giữ prob_up bằng champion_prob và ghi rõ.',
      ],
    },
    date: state.today, version: state.version,
    regime: { regions: run.regime.regions, risk: run.regime.risk },
    groups: Object.fromEntries(Object.entries(run.badges).map(([g, hs]) => [g, Object.fromEntries(Object.entries(hs).map(([h, b]) => [h, { champion: b.champion, badge: b.key, bss: b.skill, pBetter: b.pBetter }]))])),
    assets: items1.map((i) => ({
      id: i.a, name: run.data.assets.get(i.a).name, group: i.g, price: i.px, priceDate: i.pd,
      chg_1d: pct(i.a, 1), chg_7d: pct(i.a, 7), chg_30d: pct(i.a, 30),
      champion: i.champ, champion_prob: i.pc, base: i.base, models: i.p, band80_1m: [i.lo, i.hi], prob_tail_1m: i.pt, tail_k: i.k,
      prob_up_3m: items3.get(i.a)?.pc ?? null, badge_1m: i.badge,
    })),
    macro, qaIssues: state.docs['meta/status'].qaIssues, notes: state.notes,
  };
}

// ------------------------------------------------------------------ lệnh finalize

/** Kiểm và kẹp nhận định AI theo luật ở mục 4.5 của spec. */
function validateAi(ai, state) {
  if (!ai) return { ai: null, issues: ['chưa có nhận định AI'] };
  const issues = [];
  const items1 = new Map(state.live.items.filter((i) => i.h === '1m').map((i) => [i.a, i]));
  const out = { headline: String(ai.headline || ''), regime: ai.regime || {}, regions: Array.isArray(ai.regions) ? ai.regions : [],
    assets: [], risks: Array.isArray(ai.risks) ? ai.risks : [], watch: Array.isArray(ai.watch) ? ai.watch : [] };
  for (const a of Array.isArray(ai.assets) ? ai.assets : []) {
    const it = items1.get(a.id);
    if (!it) { issues.push(`${a.id}: không có trong danh sách dự báo`); continue; }
    let p = Number(a.prob_up);
    if (!Number.isFinite(p)) { p = it.pc; issues.push(`${a.id}: prob_up không hợp lệ, dùng xác suất nhà vô địch`); }
    if (p > 1) p /= 100;
    const lo = Math.max(0.05, it.pc - 0.1);
    const hi = Math.min(0.95, it.pc + 0.1);
    if (p < lo || p > hi) { issues.push(`${a.id}: prob_up ${p} ngoài ±10 điểm quanh ${it.pc}, đã kẹp`); p = Math.min(hi, Math.max(lo, p)); }
    let conf = ['thap', 'vua', 'cao'].includes(a.confidence) ? a.confidence : 'thap';
    if (it.badge !== 'strong' && conf !== 'thap') { issues.push(`${a.id}: nhóm chưa có cơ sở nên confidence phải là thap`); conf = 'thap'; }
    const evidence = Array.isArray(a.evidence) ? a.evidence.slice(0, 4) : [];
    if (evidence.length < 2) issues.push(`${a.id}: evidence dưới 2 dữ kiện`);
    const view = ['tang', 'giam', 'trung_lap'].includes(a.view) ? a.view : 'trung_lap';
    out.assets.push({ id: a.id, prob_up: Math.round(p * 1000) / 1000, view, confidence: conf, why: String(a.why || ''), bull: String(a.bull || ''),
      bear: String(a.bear || ''), evidence, vs_model: String(a.vs_model || ''), champion_prob: it.pc });
  }
  return { ai: out, issues };
}

function cmdFinalize(o) {
  const outDir = o.out || 'out';
  const state = readJson(path.join(outDir, 'state.json'));
  const aiRaw = o.ai && fs.existsSync(o.ai) ? readJson(o.ai) : null;
  const { ai, issues } = validateAi(aiRaw, state);
  const aiP = new Map((ai?.assets || []).map((a) => [a.id, a.prob_up]));
  const live = structuredClone(state.live);
  for (const it of live.items) {
    if (it.h === '1m' && aiP.has(it.a)) it.p.M6 = aiP.get(it.a);
    for (const s of state.shadow.filter((x) => x.a === it.a && x.h === it.h)) it.p[s.model] = Math.round(s.p * 1e4) / 1e4;
  }
  const createdAt = nowIso();
  const fdoc = E.forecastDoc(live, { configVersion: state.configVersion, version: state.version, createdAt,
    ai: ai ? { headline: ai.headline, assets: ai.assets.length, issues: issues.length } : null, shadow: [...new Set(state.shadow.map((s) => s.exp))] });
  const docs = { ...state.docs };
  if (state.dumpVersions[`forecasts/${state.today}`]) throw new Error(`forecasts/${state.today} đã tồn tại: sổ dự báo chỉ thêm, không sửa`);
  docs[`forecasts/${state.today}`] = fdoc;
  if (ai) docs[`analyses/${state.today}`] = { schemaVersion: E.SCHEMA_VERSION, date: state.today, version: state.version, source: 'tác vụ định kỳ', ...ai, validation: issues, createdAt };
  const bundle = readJson(path.join(outDir, 'bundle.pre.json'));
  bundle.ai = ai ? { date: state.today, ...ai, validation: issues } : null;
  const latest = {
    schemaVersion: E.SCHEMA_VERSION, date: state.today, version: state.version, generatedAt: createdAt,
    champion: state.champions,
    assets: buildLatestAssets(state),
    regime: { regions: state.regime.regions, risk: state.regime.risk },
    ai: ai ? { headline: ai.headline, label: 'AI, chưa kiểm chứng', regime: ai.regime, assets: ai.assets.map((a) => ({ id: a.id, prob_up: a.prob_up, view: a.view, confidence: a.confidence })) } : null,
    fields: E.LATEST_FIELDS,
  };
  docs['public/latest'] = latest;
  for (const v of state.versionDocs) docs[`versions/${v.version}`] = { schemaVersion: E.SCHEMA_VERSION, ...v };
  // thứ tự ghi: sổ dự báo trước, trạng thái sau cùng
  const order = (p) => (p.startsWith('forecasts/') ? 0 : p.startsWith('analyses/') ? 1 : p === 'meta/status' ? 9 : p === 'public/latest' ? 8 : 5);
  const dumpLike = Object.fromEntries(Object.entries(state.dumpVersions).map(([k, v]) => [k, { version: v }]));
  const ops = Object.keys(docs).sort((a, b) => order(a) - order(b)).map((p) => setOp(dumpLike, p, docs[p]));
  const batches = [];
  for (let i = 0; i < ops.length; i += MAX_OPS_PER_WRITE) batches.push(ops.slice(i, i + MAX_OPS_PER_WRITE));
  writeJson(path.join(outDir, 'db_writes.json'), { batches, count: ops.length });
  for (const [i, b] of batches.entries()) writeJson(path.join(outDir, `db_write_${i + 1}.json`), b);
  writeJson(path.join(outDir, 'files', 'data', 'latest.json'), latest);
  writeJson(path.join(outDir, 'files', 'data', 'bundle.json'), bundle);
  const msg = report(state, ai, issues);
  fs.writeFileSync(path.join(outDir, 'message.txt'), msg);
  console.log(JSON.stringify({ ok: true, ops: ops.length, batches: batches.length, aiIssues: issues, files: ['files/data/latest.json', 'files/data/bundle.json'], message: msg }, null, 1));
}

function buildLatestAssets(state) {
  const by = new Map(state.live.items.map((i) => [`${i.a}|${i.h}`, i]));
  const ids = [...new Set(state.live.items.map((i) => i.a))];
  return ids.map((a) => {
    const i1 = by.get(`${a}|1m`); const i3 = by.get(`${a}|3m`);
    const b1 = state.badges[(i1 || i3).g]['1m']; const b3 = state.badges[(i1 || i3).g]['3m'];
    return { id: a, group: (i1 || i3).g, price: (i1 || i3).px, priceDate: (i1 || i3).pd,
      prob_up_1m: i1?.pc ?? null, prob_up_3m: i3?.pc ?? null, base_1m: i1?.base ?? null, base_3m: i3?.base ?? null,
      lo_1m: i1?.lo ?? null, hi_1m: i1?.hi ?? null, lo_3m: i3?.lo ?? null, hi_3m: i3?.hi ?? null,
      prob_tail_1m: i1?.pt ?? null, prob_tail_3m: i3?.pt ?? null, tail_k_1m: i1?.k ?? null, tail_k_3m: i3?.k ?? null,
      badge_1m: b1.key, badge_3m: b3.key, call_1m: i1?.call ?? 0, call_3m: i3?.call ?? 0, champion_1m: b1.champion, champion_3m: b3.champion,
      skill_1m: { bss: b1.skill, pBetter: b1.pBetter }, skill_3m: { bss: b3.skill, pBetter: b3.pBetter } };
  });
}

/** Tin nhắn ≤ 12 dòng cho Mike. */
function report(state, ai, issues) {
  const items1 = state.live.items.filter((i) => i.h === '1m');
  const lines = [];
  lines.push(`macro-radar 2 · ${viDate(state.today)} · v${state.version}`);
  const us = state.regime.regions.us;
  lines.push(`Kịch bản: Mỹ ${us.label.toLowerCase()}; rủi ro ${state.regime.risk.label.toLowerCase()}.`);
  if (ai?.headline) lines.push(`AI (chưa kiểm chứng): ${ai.headline}`);
  const sm = state.scoredToday.filter((x) => x.h === '1m');
  if (sm.length) {
    const right = sm.filter((x) => (x.models[x.champ]?.p ?? 0.5) > 0.5 === (x.y === 1)).length;
    const bc = sm.reduce((s, x) => s + (x.models[x.champ]?.b ?? 0), 0) / sm.length;
    const b1 = sm.reduce((s, x) => s + (x.models.M1?.b ?? 0), 0) / sm.length;
    lines.push(`Tới hạn 1 tháng (dự báo ${viDate(sm[0].fd)}): đúng hướng ${right}/${sm.length}; Brier ${fmtNum(bc, 3)} so với M1 ${fmtNum(b1, 3)}.`);
  } else lines.push('Chưa có dự báo trực tiếp nào tới hạn (kỳ 1 tháng tới hạn sau 30 ngày kể từ lần chạy đầu).');
  const strong = [];
  for (const [g, hs] of Object.entries(state.badges)) for (const [h, b] of Object.entries(hs)) if (b.key === 'strong') strong.push(`${g} ${h} (${b.champion}, BSS ${fmtNum(b.skill, 3)})`);
  lines.push(`Kỹ năng đã kiểm chứng: ${strong.length ? strong.join('; ') : 'chưa nhóm nào có cơ sở'}.`);
  if (state.moves?.length) lines.splice(1, 0, `Thị trường phiên gần nhất: ${state.moves.map((m) => `${m.name} ${m.ch >= 0 ? '+' : '−'}${m.kind === 'yield' ? fmtNum(Math.abs(m.ch) * 100, 0) + ' điểm cơ bản' : fmtPct(Math.abs(m.ch))}`).join(', ')}.`);
  const notes = [...state.versionEvents.map((e) => e.text), ...(state.optimize && !state.optimize.accepted ? [`Tối ưu: không đổi (${state.optimize.reason})`] : [])];
  lines.push(notes.length ? `Thay đổi: ${notes.join('; ')} → v${state.version}.` : `Không đổi tham số hay mô hình (v${state.version}).`);
  const qaIssues = state.docs['meta/status'].qaIssues || [];
  if (qaIssues.length || state.errors.length) lines.push(`Sự cố số liệu: ${[...qaIssues, ...state.errors].slice(0, 3).join('; ')}`);
  if (state.manualDue.length) lines.push(`Chờ số Việt Nam: ${state.manualDue.map((m) => m.name).join(', ')}.`);
  if (ai?.risks?.length) lines.push(`Rủi ro theo dõi: ${ai.risks.slice(0, 2).join('; ')}`);
  if (issues.length && ai) lines.push(`Nhận định AI bị điều chỉnh ${issues.length} chỗ cho đúng luật.`);
  lines.push('Công cụ tham khảo, không khuyến nghị mua bán.');
  return lines.slice(0, 12).join('\n');
}

// ------------------------------------------------------------------ lệnh manual, rollback

function cmdManual(o) {
  const dump = loadDump(o.dump);
  const def = MANUAL_SERIES.find((m) => m.id === o.id);
  if (!def) throw new Error(`không có chuỗi nhập tay ${o.id}`);
  const value = Number(String(o.value).replace(',', '.'));
  if (!Number.isFinite(value)) throw new Error('giá trị không hợp lệ');
  if (!/^\d{4}-\d{2}$/.test(o.period || '')) throw new Error('period phải dạng YYYY-MM');
  const parse = (s) => { if (!s || s === true) return null; const [name, url] = String(s).split('|'); return { name, url }; };
  const sources = [parse(o.src1), parse(o.src2)].filter(Boolean);
  if (!sources.length) throw new Error('cần ít nhất một nguồn (--src1 "Tên|url")');
  const key = `manual/${def.id}`;
  const cur = dump[key]?.data || { schemaVersion: E.SCHEMA_VERSION, ...Object.fromEntries(Object.entries(def).filter(([k]) => !['releaseDay', 'hint'].includes(k))), source: { code: 'manual', name: 'Thông cáo chính thức (nhập tay)', url: '' }, d: [], v: [], src: [] };
  const date = `${o.period}-01`;
  const i = cur.d.indexOf(date);
  const entry = { date, value, sources, confidence: sources.length >= 2 ? '2 nguồn' : '1 nguồn', recordedAt: nowIso() };
  if (i >= 0) {
    if (cur.v[i] !== value) entry.revisedFrom = cur.v[i];
    cur.v[i] = value; cur.src[i] = entry;
  } else {
    const k = cur.d.findIndex((d) => d > date);
    const at = k < 0 ? cur.d.length : k;
    cur.d.splice(at, 0, date); cur.v.splice(at, 0, value); cur.src.splice(at, 0, entry);
  }
  const op = setOp(dump, key, cur);
  writeJson(path.join(o.out || 'out', `manual_${def.id}.json`), [op]);
  console.log(JSON.stringify({ ok: true, write: `manual_${def.id}.json`, confidence: entry.confidence }));
}

function cmdRollback(o) {
  const dump = loadDump(o.dump);
  const v = dump[`versions/${o.to}`]?.data;
  if (!v?.snapshot) throw new Error(`thiếu versions/${o.to} trong dump`);
  const status = structuredClone(dump['meta/status']?.data || {});
  const cur = dump['config/current']?.data || {};
  const newVersion = bumpVersion(status.version || INITIAL_VERSION, 'patch');
  const cfgOut = { schemaVersion: E.SCHEMA_VERSION, configVersion: (cur.configVersion || 1) + 1, updatedAt: vnToday(), config: v.snapshot.config };
  const reg = structuredClone(dump['models/registry']?.data || {});
  reg.champion = v.snapshot.champion;
  reg.history = [...(reg.history || []), { date: vnToday(), event: 'quay lại', to: o.to }];
  status.version = newVersion;
  const ops = [setOp(dump, 'config/current', cfgOut), setOp(dump, `config/v${cfgOut.configVersion}`, cfgOut), setOp(dump, 'models/registry', reg),
    setOp(dump, `versions/${newVersion}`, { schemaVersion: E.SCHEMA_VERSION, version: newVersion, date: vnToday(), events: [{ kind: 'patch', type: 'rollback', text: `Quay lại cấu hình và nhà vô địch của ${o.to}` }], snapshot: v.snapshot }),
    setOp(dump, 'meta/status', status)];
  writeJson(path.join(o.out || 'out', 'rollback.json'), ops);
  console.log(JSON.stringify({ ok: true, version: newVersion, ops: ops.length }));
}

// ------------------------------------------------------------------ main

const o = args(process.argv.slice(2));
const cmd = o._[0];
try {
  if (cmd === 'fetch') cmdFetch(o);
  else if (cmd === 'plan') cmdPlan(o);
  else if (cmd === 'run') cmdRun(o);
  else if (cmd === 'finalize') cmdFinalize(o);
  else if (cmd === 'manual') cmdManual(o);
  else if (cmd === 'rollback') cmdRollback(o);
  else {
    console.log('Dùng: node tools/mrc.mjs fetch|plan|run|finalize|manual|rollback ... (xem đầu file)');
    process.exitCode = cmd ? 1 : 0;
  }
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: e.message, stack: e.stack?.split('\n').slice(0, 4) }));
  process.exitCode = 1;
}
