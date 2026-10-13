/* 由 DataV 市级边界 + dynasties.js 生成 js/data/geo-shape.js（政权外轮廓）
 *
 * 步骤：
 *   1) node tools/fetch-geo.js        # 抓取原始边界到 tools/raw
 *   2) node tools/build-shape.js      # 生成 js/data/geo-shape.js
 *
 * 依赖 polygon-clipping（npm i polygon-clipping）。若失败，可用
 *   NODE_PATH=/Users/Fair/.workbuddy/binaries/node/workspace/node_modules node tools/build-shape.js
 *
 * 逻辑：每个政权的轮廓 = (所列省份的全部市 − cityDel + cityAdd + extra) 的多边形并集，
 *       再做 Douglas-Peucker 简化。这样只描外边界，不会出现逐市描边的内部网格。
 */
require('module').Module._initPaths();
const pc = require('polygon-clipping');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROV_IDX = path.join(ROOT, 'tools', 'prov_index.json');
const DYN = path.join(ROOT, 'js/data', 'dynasties.js');
const OUT = path.join(ROOT, 'js/data', 'geo-shape.js');

// 粒度模式：默认市级（tools/raw，省文件的直接下级=地级市）；
// --county 切换到县级（tools/raw-county，每个地级文件的直接下级=县/区/旗）。
// 县级模式容差更细（0.01°≈1.1km），VW 尖刺阈值同步下调，放大后可见县界级细节。
const COUNTY = process.argv.includes('--county');
const RAW = COUNTY ? path.join(ROOT, 'tools', 'raw-county') : path.join(ROOT, 'tools', 'raw');
const RAW_CITY = path.join(ROOT, 'tools', 'raw');
const TOL = COUNTY ? 0.01 : 0.03;       // DP 简化容差（度）
const VW_TOL = COUNTY ? 0.005 : 0.02;   // Visvalingam 尖刺滤波阈值（度²）
const VW_MIN_RING = 2;                  // 只对面积 >2°² 的大环做尖刺滤波（保护小岛/飞地）
const MIN_AREA = 6e-4;                  // 丢弃过小环（度²）
const MUNI = [110000, 120000, 310000, 500000, 810000, 820000]; // 直辖市/港澳的省级文件本身就是区级

// Visvalingam-Whyatt 面积滤波：按三角形面积从小到大剔除顶点。
// 为什么需要它：Douglas-Peucker 在密集摆动边界（现代市界沿河流山脊高频抖动）上
// 会保留每个极值点，简化后仍是锯齿——实测东汉外环 69% 是短步长、163 处折返尖刺，
// 在内蒙古（市界与手绘蒙古高原环的接缝）一带看得最明显。
// VW 按「大边小面积」剔除，正好命中尖刺，同时保住真正的折角与岛屿；
// 实测东汉外环 1586 → 399 顶点，面积变化 0.11%。
function vwDespike(pts, areaTol) {
  const n = pts.length;
  if (n < 6) return pts;
  const prev = new Array(n), next = new Array(n);
  for (let i = 0; i < n; i++) { prev[i] = (i - 1 + n) % n; next[i] = (i + 1) % n; }
  const alive = new Array(n).fill(true);
  const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  let removed = true;
  while (removed) {
    removed = false;
    for (let i = 1; i < n - 1; i++) {          // 保护首尾顶点
      if (!alive[i]) continue;
      if (tri(pts[prev[i]], pts[i], pts[next[i]]) < areaTol) {
        alive[i] = false;
        next[prev[i]] = next[i]; prev[next[i]] = prev[i];
        removed = true;
      }
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (alive[i]) out.push(pts[i]);
  return out.length >= 4 ? out : pts;
}

function sqSegDist(p, a, b) {
  let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
  }
  return (p[0] - x) ** 2 + (p[1] - y) ** 2;
}
function dpStep(pts, f, l, sq, out) {
  let mx = sq, idx = -1;
  for (let i = f + 1; i < l; i++) { const s = sqSegDist(pts[i], pts[f], pts[l]); if (s > mx) { idx = i; mx = s; } }
  if (idx > 0) { dpStep(pts, f, idx, sq, out); out.push(pts[idx]); dpStep(pts, idx, l, sq, out); }
}
function simplify(pts, tol) {
  const p = [pts[0]];
  for (let i = 1; i < pts.length; i++) if (pts[i][0] !== p[p.length - 1][0] || pts[i][1] !== p[p.length - 1][1]) p.push(pts[i]);
  if (p.length < 4) return p;
  const out = [p[0]]; dpStep(p, 0, p.length - 1, tol * tol, out); out.push(p[p.length - 1]); return out;
}
function ringArea(r) { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; }
function r4(r) { return r.map(q => [Math.round(q[0] * 1e4) / 1e4, Math.round(q[1] * 1e4) / 1e4]); }

// ---- 标注点：最大内切圆圆心（polylabel 近似，格网 + 细化） ----
// 为什么不用面积质心：含西域/漠北的大帝国（唐/元）质心会被偏远疆域整体拉向西北，
// 落到帝国边缘；最大内切圆圆心总是落在「最厚实」的腹地，更贴合核心区。
function insideRing(pt, r) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) c = !c;
  }
  return c;
}
function insideShape(pt, polys) {
  for (const poly of polys) {
    if (!insideRing(pt, poly[0])) continue;
    let hole = false;
    for (let h = 1; h < poly.length; h++) if (insideRing(pt, poly[h])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}
function segDist2(px, py, ax, ay, bx, by) {
  let x = ax, y = ay, dx = bx - x, dy = by - y;
  if (dx !== 0 || dy !== 0) { const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy); if (t > 1) { x = bx; y = by; } else if (t > 0) { x += dx * t; y += dy * t; } }
  return (px - x) ** 2 + (py - y) ** 2;
}
function polylabel(polys) {
  let ring = null, bA = 0;
  for (const poly of polys) {
    const r = poly[0]; if (!r || r.length < 3) continue;
    let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; }
    a = Math.abs(a) / 2;
    if (a > bA) { bA = a; ring = r; }
  }
  if (!ring) return null;
  const d2 = (x, y) => {
    let m = Infinity;
    for (let i = 0; i < ring.length - 1; i++) { const v = segDist2(x, y, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]); if (v < m) m = v; }
    return m;
  };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0]; if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  let cell = Math.max(maxX - minX, maxY - minY) / 32;
  let bx = (minX + maxX) / 2, by = (minY + maxY) / 2, bd = -1;
  for (let it = 0; it < 3; it++) {
    for (let x = minX; x <= maxX; x += cell) for (let y = minY; y <= maxY; y += cell) {
      if (!insideShape([x, y], polys)) continue;
      const d = d2(x, y);
      if (d > bd) { bd = d; bx = x; by = y; }
    }
    minX = bx - cell; maxX = bx + cell; minY = by - cell; maxY = by + cell; cell /= 5;
  }
  return [Math.round(bx * 1e4) / 1e4, Math.round(by * 1e4) / 1e4];
}

global.window = {};
require(DYN);
const D = window.DYNASTIES;

function featPolys(g) { if (!g) return []; return g.type === 'Polygon' ? [g.coordinates] : g.coordinates; }
const idx = JSON.parse(fs.readFileSync(PROV_IDX, 'utf8'));
const provByCode = {}; for (const f of idx.features) provByCode[f.properties.adcode] = f;

// ---- 单位加载 ----
// 市级模式：省文件的直接下级（地级市）即单位。
// 县级模式：地级文件的直接下级（县/区/旗）即单位；每个单位记录所属省与所属地级，
//           使 cityDel 支持三级语义：市名=删该市全部县、县名=删单县、省名=删全省。
const units = [];
const prefName = {};   // 地级 adcode -> 地级名（县级模式按文件反查；直辖市为自己）
if (!COUNTY) {
  for (const file of fs.readdirSync(RAW)) {
    const code = +file.replace('.json', '');
    if (MUNI.includes(code)) continue;
    const j = JSON.parse(fs.readFileSync(path.join(RAW, file), 'utf8'));
    const provName = provByCode[code] ? provByCode[code].properties.name : String(code);
    for (const ft of j.features) units.push({ n: ft.properties.name, prov: provName, polys: featPolys(ft.geometry) });
  }
  for (const code of MUNI) {
    const f = provByCode[code]; if (!f) continue;
    const name = f.properties.name;
    units.push({ n: name, prov: name, polys: featPolys(f.geometry) });
  }
} else {
  // 地级 adcode -> 省名 / 地级名（来自市级 raw）
  const prefProv = {};
  for (const file of fs.readdirSync(RAW_CITY)) {
    const code = +file.replace('.json', ''); if (!code) continue;
    const j = JSON.parse(fs.readFileSync(path.join(RAW_CITY, file), 'utf8'));
    const pn = provByCode[code] ? provByCode[code].properties.name : String(code);
    for (const ft of j.features) { prefProv[ft.properties.adcode] = pn; prefName[ft.properties.adcode] = ft.properties.name; }
  }
  for (const code of MUNI) { prefProv[code] = provByCode[code] ? provByCode[code].properties.name : String(code); prefName[code] = provByCode[code] ? provByCode[code].properties.name : String(code); }
  for (const file of fs.readdirSync(RAW)) {
    const ad = +file.replace('.json', '');
    const provName = prefProv[ad];
    if (!provName) { console.log('WARN 县级文件无对应省份:', file); continue; }
    const j = JSON.parse(fs.readFileSync(path.join(RAW, file), 'utf8'));
    for (const ft of j.features) units.push({ n: ft.properties.name, prov: provName, pref: prefName[ad], polys: featPolys(ft.geometry) });
  }
  // 省直辖县级单位（无下级的地级块）：新疆兵团师市、嘉峪关、济源、海南省直辖市等。
  // 它们不挂在任何地级文件下，直接从市级省文件中按「叶子」纳入，保持 cityDel 可按名删除。
  for (const file of fs.readdirSync(RAW_CITY)) {
    const code = +file.replace('.json', ''); if (!code) continue;
    const j = JSON.parse(fs.readFileSync(path.join(RAW_CITY, file), 'utf8'));
    const pn = provByCode[code] ? provByCode[code].properties.name : String(code);
    for (const ft of j.features) {
      if (!ft.properties.childrenNum) units.push({ n: ft.properties.name, prov: pn, pref: null, polys: featPolys(ft.geometry) });
    }
  }
  // 台湾：DataV 无县级数据，用省级整块
  const tw = provByCode[710000];
  if (tw) units.push({ n: tw.properties.name, prov: tw.properties.name, polys: featPolys(tw.geometry) });
}

// 三种索引：省 -> 单位[]；地级 -> 单位[]；县名 -> 单位[]（重名县收齐全量）
const byProv = {}, byPref = {}, byName = {};
for (const u of units) {
  (byProv[u.prov] = byProv[u.prov] || []).push(u);
  if (u.pref) (byPref[u.pref] = byPref[u.pref] || []).push(u);
  (byName[u.n] = byName[u.n] || []).push(u);
}

// cityDel 名称解析：市名（向后兼容市级名单）> 县名 > 省名
function resolveDel(names) {
  const del = {};
  const warn = [];
  for (const n of names) {
    if (byPref[n]) { for (const u of byPref[n]) del[u.n] = 1; continue; }
    if (byName[n]) { for (const u of byName[n]) del[u.n] = 1; if (byName[n].length > 1) warn.push(n + '(重名×' + byName[n].length + ')'); continue; }
    if (byProv[n]) { for (const u of byProv[n]) del[u.n] = 1; warn.push(n + '(省名删全省)'); continue; }
    warn.push(n + '(未知)');
  }
  return { del, warn };
}
function resolveAdd(n) {
  if (byName[n]) return byName[n];
  if (byPref[n]) return byPref[n];
  if (byProv[n]) return byProv[n];
  return null;
}

// ---- 分层并集 ----
// 全国级政权一次并集 ~2800 个县会撑爆 polygon-clipping 的 Martinez 优先队列
// （"queue size too big"）。改为两级：先在省内把各县并成大环（每省约百个县），
// 再把 ~31 个省级结果 + extra 做最终并集。按 (省, 剔除集) 缓存，构建总量大降。
const provCache = {};
function unionPolys(polys) {
  if (polys.length <= 1) return polys;
  try { return pc.union(polys); } catch (e) { return null; }
}
function unionProvince(provName, del) {
  const arr = byProv[provName];
  if (!arr) return [];
  // 缓存键：省 + 该省被剔除的县名单
  const delNames = arr.filter(u => del[u.n]).map(u => u.n).sort().join(',');
  const key = provName + '|' + delNames;
  if (provCache[key] !== undefined) return provCache[key];
  const polys = [];
  for (const u of arr) { if (del[u.n]) continue; for (const p of u.polys) polys.push(p); }
  let merged = unionPolys(polys);
  if (merged === null) {
    // 省级仍超限（如新疆单元极多）：逐个合并兜底
    let acc = [];
    for (const p of polys) {
      const m = unionPolys(acc.concat([p]));
      acc = m === null ? acc.concat([p]) : m;
    }
    merged = acc;
  }
  provCache[key] = merged;
  return merged;
}

const out = {}, labels = {};
const allWarn = [];
for (const d of D) {
  const rd = resolveDel(d.cityDel || []);
  for (const w of rd.warn) allWarn.push(d.id + ' -> ' + w);
  const del = rd.del;
  // 第一级：所列省份逐省并集
  const provPolys = [];
  for (const pn of d.provNames) {
    for (const poly of unionProvince(pn, del)) provPolys.push(poly);
  }
  // cityAdd：按县/市名直接补多边形（县级模式下市名=该市全部县）。
  // 不并入省级并集——cityAdd 可能只补某省的一两个地级（如匈奴补塔里木诸州），
  // 若按省并集会误把全省纳入。del 优先于 cityAdd。
  for (const n of (d.cityAdd || [])) {
    const arr = resolveAdd(n);
    if (arr) for (const u of arr) { if (del[u.n]) continue; for (const poly of u.polys) provPolys.push(poly); }
  }
  for (const ring of d.extra) provPolys.push([ring]);
  // 第二级：省级结果 + cityAdd + extra 总并集
  let merged = unionPolys(provPolys);
  if (merged === null) { console.log('UNION FAIL', d.id); merged = provPolys; }
  const shape = [];
  for (const poly of merged) {
    // 只保留外环：并集产生的「洞」几乎都是相邻单元边缘未完全重合的缝隙——
    // 内蒙古各盟市之间、以及内蒙古与手工 extra（蒙古高原等）之间最明显，
    // 最长的一条横跨 16° 经度（漠南一带），在图上渲染成月牙形暗色裂缝。
    // 这些并非真实空洞（缝隙两侧都是该政权辖地），填充外环即可消除。
    let s = simplify(poly[0], TOL);
    // 尖刺滤波：仅大环（本土主力轮廓），小岛/飞地保持 DP 原样
    if (ringArea(s) > VW_MIN_RING) s = vwDespike(s, VW_TOL);
    if (s.length < 4 || ringArea(s) < MIN_AREA) continue;
    if (s[0][0] !== s[s.length - 1][0] || s[0][1] !== s[s.length - 1][1]) s.push(s[0]);
    shape.push([r4(s)]);
  }
  out[d.id] = shape;
  const lp = polylabel(shape);
  if (lp) labels[d.id] = lp;
}

const js = '/* 政权外轮廓（自动生成，勿手工编辑；见 tools/build-shape.js）\n'
  + ' * ' + (COUNTY ? '县级' : '市级') + '边界 + dynasties.extra 做多边形并集，仅描外边界（无内部网格）。\n'
  + ' * GEO_SHAPE[id] = MultiPolygon: [ [外环, ...内环], ... ]；GEO_LABEL[id] = 政权名标注点（最大内切圆圆心）。\n'
  + ' */\n'
  + 'window.GEO_SHAPE = ' + JSON.stringify(out) + ';\n'
  + 'window.GEO_LABEL = ' + JSON.stringify(labels) + ';\n';
fs.writeFileSync(OUT, js);
console.log('模式:', COUNTY ? '县级(--county)' : '市级', '| 单位数:', units.length);
console.log('写出', OUT, (js.length / 1024).toFixed(0) + 'KB', '标签数', Object.keys(labels).length);
if (allWarn.length) { console.log('cityDel 警告:'); for (const w of allWarn) console.log('  ', w); }
else console.log('cityDel 全部解析成功');
