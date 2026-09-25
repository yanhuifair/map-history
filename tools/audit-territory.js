/* 疆域数据全量审计：数据层 + 几何层
 * 用法：node tools/audit.js       （依赖 tools/raw 的市级边界；若缺失先跑 fetch-geo.js）
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const RAW = path.join(__dirname, 'raw');
const PROV_IDX = path.join(__dirname, 'prov_index.json');

global.window = {};
require(path.join(ROOT, 'js/data/dynasties.js'));
require(path.join(ROOT, 'js/data/geo-shape.js'));
const D = window.DYNASTIES, S = window.GEO_SHAPE, L = window.GEO_LABEL, PM = window.PROV_MAP;

// ---------- 市单位名（与 build-shape 一致） ----------
const unitsByName = {}, unitProv = {};
let haveRaw = fs.existsSync(RAW) && fs.existsSync(PROV_IDX);
if (haveRaw) {
  const idx = JSON.parse(fs.readFileSync(PROV_IDX, 'utf8'));
  const provByCode = {}; for (const f of idx.features) provByCode[f.properties.adcode] = f.properties.name;
  const MUNI = [110000, 120000, 310000, 500000, 810000, 820000, 710000];
  for (const file of fs.readdirSync(RAW)) {
    const code = +file.replace('.json', ''); if (MUNI.includes(code)) continue;
    const j = JSON.parse(fs.readFileSync(path.join(RAW, file), 'utf8'));
    const pn = provByCode[code] || String(code);
    for (const ft of j.features) { unitsByName[ft.properties.name] = 1; unitProv[ft.properties.name] = pn; }
  }
  for (const code of MUNI) { const pn = provByCode[code]; if (pn) { unitsByName[pn] = 1; unitProv[pn] = pn; } }
}

const problems = [];
const P = (kind, msg) => problems.push('[' + kind + '] ' + msg);

// ---------- 1. 字段完整性 & 省名有效性 ----------
const ids = {};
for (const d of D) {
  if (ids[d.id]) P('重复id', d.id);
  ids[d.id] = 1;
  for (const k of ['name', 'start', 'end', 'level', 'color', 'desc']) if (d[k] === undefined) P('缺字段', d.id + ' 缺 ' + k);
  if (!d.cap) P('缺都城', d.id);
  if (!(d.end >= d.start)) P('年份倒置', d.id + ' ' + d.start + '~' + d.end);
  // prov 简称 -> 全称
  const toks = (d.prov || '').trim() ? d.prov.trim().split(/\s+/) : [];
  for (const t of toks) if (!PM[t]) P('未知省简称', d.id + ' -> 「' + t + '」');
  // cityDel / cityAdd 名单是否真实存在
  for (const n of (d.cityDel || [])) { if (haveRaw && !unitsByName[n]) P('cityDel 名称无效', d.id + ' -> ' + n); else if (haveRaw && unitProv[n] && d.provNames.indexOf(unitProv[n]) < 0) P('cityDel 省外(冗余)', d.id + ' -> ' + n + ' 属 ' + unitProv[n]); }
  for (const n of (d.cityAdd || [])) if (haveRaw && !unitsByName[n]) P('cityAdd 名称无效', d.id + ' -> ' + n);
  // provNames 展开非空
  if (toks.length && !d.provNames.length) P('provNames 为空', d.id);
}

// ---------- 1b. extra 手工环自交检查（蝴蝶结会被并集切成两块 → 图上出现游离小块） ----------
const GE = window.GEO_EXTRA || {};
function orient(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
function onSeg(a, b, c) { return Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]); }
function segCross(p1, p2, p3, p4) {
  const d1 = orient(p3, p4, p1), d2 = orient(p3, p4, p2), d3 = orient(p1, p2, p3), d4 = orient(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSeg(p3, p4, p1)) return true;
  if (d2 === 0 && onSeg(p3, p4, p2)) return true;
  if (d3 === 0 && onSeg(p1, p2, p3)) return true;
  if (d4 === 0 && onSeg(p1, p2, p4)) return true;
  return false;
}
function ringName(ring) { for (const k in GE) if (GE[k] === ring) return 'G.' + k; return 'inline'; }
for (const d of D) {
  (d.extra || []).forEach((ring, ri) => {
    const n = ring.length; if (n < 4) return;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;   // 相邻边
      if (segCross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n]))
        P('extra 环自交', d.id + ' ' + ringName(ring) + ' 第' + i + '×' + j + ' 段');
    }
  });
}

// ---------- 2. 几何层 ----------
function ringArea(r) { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; }
function polyCentroid(r) { let a = 0, cx = 0, cy = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; const f = p[0] * q[1] - q[0] * p[1]; a += f; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f; } a /= 2; return Math.abs(a) < 1e-12 ? [r[0][0], r[0][1]] : [cx / (6 * a), cy / (6 * a)]; }

for (const d of D) {
  const polys = S[d.id];
  if (!polys || !polys.length) { P('轮廓为空', d.id); continue; }
  let holes = 0; for (const poly of polys) holes += poly.length - 1;
  if (holes) P('存在内环(会渲染成暗缝)', d.id + ' 洞=' + holes);
  if (!L[d.id]) P('缺标注点', d.id);

  // 各连通块面积 + 质心
  const comps = polys.map(poly => ({ area: ringArea(poly[0]), c: polyCentroid(poly[0]) })).sort((a, b) => b.area - a.area);
  const main = comps[0];
  // 已知的「合理离岛/飞地」白名单（海南、台湾）——本图按现代省界，它们是独立岛
  const KNOWN = [[109.8, 19.2], [121.0, 23.7]];
  const isKnown = c => KNOWN.some(k => Math.hypot((c[0] - k[0]), (c[1] - k[1])) < 2.5);
  // 孤立远块：面积 >0.3°² 且质心距主块 >4°，且不在白名单
  comps.slice(1).forEach(k => {
    if (k.area < 0.3) return;
    if (isKnown(k.c)) return;
    const dx = (k.c[0] - main.c[0]) * Math.cos((main.c[1] + k.c[1]) / 2 * Math.PI / 180), dy = k.c[1] - main.c[1];
    const dist = Math.hypot(dx, dy);
    if (dist > 4) P('孤立远块', d.id + ' 距主块 ' + dist.toFixed(1) + '°，面积 ' + k.area.toFixed(1) + '°²，质心 (' + k.c[0].toFixed(1) + ',' + k.c[1].toFixed(1) + ')');
  });
  // bbox 合理性
  let mn = [999, 999], mx = [-999, -999];
  for (const poly of polys) for (const q of poly[0]) { mn[0] = Math.min(mn[0], q[0]); mn[1] = Math.min(mn[1], q[1]); mx[0] = Math.max(mx[0], q[0]); mx[1] = Math.max(mx[1], q[1]); }
  if (mn[0] < -180 || mx[0] > 180 || mn[1] < -90 || mx[1] > 90) P('坐标越界', d.id);
}

// ---------- 3. 同一年份的「覆盖空洞」抽查 ----------
// 对每年活跃政权取并集，看主流中国区域是否出现异常大空白
// （简化：只报告某年活跃政权数，以及完全没有政权标注点的年份区间）
const years = [];
for (let y = -2100; y <= 2030; y += 10) {
  const act = D.filter(d => y >= d.start && y <= d.end);
  if (!act.length) years.push(y);
}
if (years.length) {
  // 合并连续区间
  const segs = []; let s0 = years[0], prev = years[0];
  for (let i = 1; i < years.length; i++) { if (years[i] !== prev + 10) { segs.push([s0, prev]); s0 = years[i]; } prev = years[i]; }
  segs.push([s0, prev]);
  P('空档年份', '以下区间无任何政权：' + segs.map(s => s[0] + '~' + s[1]).join(', '));
}

// ---------- 输出 ----------
console.log('政权数', D.length, '｜市单位', Object.keys(unitsByName).length, '｜原始市界数据', haveRaw ? '有' : '缺(跳过市名校验)');
if (!problems.length) console.log('\n✅ 未发现问题');
else {
  const byKind = {};
  problems.forEach(p => { const k = p.slice(1, p.indexOf(']')); (byKind[k] = byKind[k] || []).push(p); });
  for (const k in byKind) { console.log('\n── ' + k + ' (' + byKind[k].length + ') ──'); byKind[k].forEach(x => console.log('  ' + x)); }
  console.log('\n合计', problems.length, '条');
}
