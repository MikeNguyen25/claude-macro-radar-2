// Chuỗi Việt Nam chưa có API: đọc từ thông cáo, dùng chung cho runner và trang.

/** Chuỗi Việt Nam không có API: đọc thông cáo; 2 nguồn khớp ghi "2 nguồn", 1 nguồn ghi rõ. */
export const MANUAL_SERIES = [
  { id: 'vn_cpi', name: 'CPI Việt Nam (% so cùng kỳ)', region: 'vn', factor: 'inflation', unit: '%', freq: 'M', releaseDay: 7,
    hint: 'Cục Thống kê (nso.gov.vn) công bố đầu tháng sau: "CPI tháng X tăng ...% so với cùng kỳ năm trước".' },
  { id: 'vn_core_cpi', name: 'Lạm phát cơ bản Việt Nam (% so cùng kỳ)', region: 'vn', factor: 'inflation', unit: '%', freq: 'M', releaseDay: 7,
    hint: 'Cùng thông cáo CPI của Cục Thống kê: "lạm phát cơ bản tháng X tăng ...% so với cùng kỳ".' },
  { id: 'vn_pmi', name: 'PMI sản xuất Việt Nam (S&P Global)', region: 'vn', factor: 'growth', unit: 'điểm', freq: 'M', releaseDay: 3,
    hint: 'S&P Global công bố ngày làm việc đầu tháng sau.' },
  { id: 'vn_refi', name: 'Lãi suất tái cấp vốn NHNN', region: 'vn', factor: 'policy', unit: '%', freq: 'M', releaseDay: 2,
    hint: 'Ngân hàng Nhà nước (sbv.gov.vn): mức đang áp dụng cuối tháng.' },
];

/** Chuỗi nhập tay đến hạn: kỳ mới nhất đáng lẽ đã công bố mà chưa có. */
export function manualDue(docs, today) {
  const [y, m, d] = today.split('-').map(Number);
  const due = [];
  for (const def of MANUAL_SERIES) {
    const doc = docs.find((x) => x.id === def.id);
    const last = doc?.d?.length ? doc.d[doc.d.length - 1].slice(0, 7) : null;
    let py = y; let pm = m - 1;
    if (d < def.releaseDay) pm -= 1;
    while (pm < 1) { pm += 12; py -= 1; }
    const expected = `${py}-${String(pm).padStart(2, '0')}`;
    if (!last || last < expected) due.push({ id: def.id, name: def.name, period: expected, hint: def.hint, last });
  }
  return due;
}

