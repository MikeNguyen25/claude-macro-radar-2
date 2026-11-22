// Nạp dữ liệu của trang: file đi kèm artifact (bundle, history, ledger) và các capability của nền tảng.

export const S = {
  core: null,          // data/bundle.json
  history: null,       // data/history.json (nạp sau, khi cần)
  historyP: null,
  error: null,
  caps: { user: null, db: null, sample: null, downloads: null },
  capsReady: false,
  owner: false,
  dbWriteOk: null,
  ui: {},              // trạng thái giao diện theo trang (lựa chọn nhóm, kỳ hạn...)
  aiRun: null,         // nhận định AI chạy tay trong phiên này
  sandbox: null,       // kết quả bàn thử cấu hình
};

const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
export const emit = () => { for (const fn of listeners) fn(); };

export async function fetchJson(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-cache' });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `${url}: quá ${timeoutMs / 1000} giây không phản hồi` : e.message);
  } finally {
    clearTimeout(t);
  }
}

export async function loadCore() {
  try {
    S.core = await fetchJson('data/bundle.json');
  } catch (e) {
    S.error = `Không tải được số liệu (${e.message}). Thử tải lại trang sau ít phút.`;
  }
  emit();
}

/** Lịch sử giá, chuỗi vĩ mô và dự báo kiểm định: chỉ nạp khi trang cần. */
export function loadHistory() {
  if (!S.historyP) {
    S.historyP = fetchJson('data/history.json', 30000)
      .then((h) => { S.history = h; emit(); return h; })
      .catch((e) => { S.historyError = e.message; emit(); return null; });
  }
  return S.historyP;
}

/** Capability của nền tảng: thiếu thì trả null và trang vẫn chạy với file. */
export async function initCaps() {
  const use = (name) => (window.claude?.use ? Promise.resolve(window.claude.use(name)).catch(() => null) : Promise.resolve(null));
  const [user, db, sample, downloads] = await Promise.all(['user', 'db', 'sample', 'downloads'].map(use));
  S.caps = { user, db, sample, downloads };
  if (user) {
    S.owner = await user.isOwner().catch(() => false);
    S.dbWriteOk = await user.can('data.write').catch(() => null);
  }
  S.capsReady = true;
  emit();
}

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: quá ${ms / 1000} giây`)), ms))]);

export async function dbGet(path) {
  const db = S.caps.db;
  if (!db) return null;
  const snap = await withTimeout(db.doc(path).get(), 10000, path);
  return snap.exists ? snap.data() : null;
}

export async function dbList(collection, { orderBy, dir = 'desc', limit = 30 } = {}) {
  const db = S.caps.db;
  if (!db) return null;
  let q = db.collection(collection);
  if (orderBy) q = q.orderBy(orderBy, dir);
  q = q.limit(limit);
  const snap = await withTimeout(q.get(), 10000, collection);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function dbSet(path, data) {
  const db = S.caps.db;
  if (!db) throw new Error('Không có cơ sở dữ liệu trong khung xem này.');
  await db.doc(path).set(data);
}

/** Lưu file qua capability downloads; không có thì trả false để trang đưa nút sao chép. */
export async function saveFile(filename, data) {
  const dl = S.caps.downloads;
  if (!dl) return false;
  await dl.save({ filename, data });
  return true;
}

export const byId = (id) => S.core?.assets.find((a) => a.id === id);
export const liveOf = (id, h) => S.core?.live.find((i) => i.a === id && i.h === h);
export const histOf = (id) => S.history?.assets.find((a) => a.id === id);
export const seriesHist = (id) => S.history?.series.find((s) => s.id === id)?.hist;
