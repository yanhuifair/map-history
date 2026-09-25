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
const RAW = path.join(__dirname, 'raw');
const PROV_IDX = path.join(__dirname, 'prov_index.json');
const DYN = path.join(ROOT, 'js/data/dynasties.js');
const OUT = path.join(ROOT, 'js/data/geo-shape.js');

const TOL = 0.03;         // 简化容差（度）
const MIN_AREA = 6e-4;    // 丢弃过小环（度²）
const MUNI = [110000, 120000, 310000, 500000, 810000, 820000, 710000]; // 直辖市/港澳台用整块

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

global.window = {};
require(DYN);
const D = window.DYNASTIES;

function featPolys(g) { if (!g) return []; return g.type === 'Polygon' ? [g.coordinates] : g.coordinates; }
const idx = JSON.parse(fs.readFileSync(PROV_IDX, 'utf8'));
const provByCode = {}; for (const f of idx.features) provByCode[f.properties.adcode] = f;

const units = [];
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
const byProv = {}, byName = {};
for (const u of units) { (byProv[u.prov] = byProv[u.prov] || []).push(u); if (!(u.n in byName)) byName[u.n] = u; }

const out = {};
for (const d of D) {
  const del = {}; (d.cityDel || []).forEach(n => del[n] = 1);
  const polys = [];
  for (const pn of d.provNames) { const arr = byProv[pn]; if (!arr) continue; for (const u of arr) { if (del[u.n]) continue; for (const poly of u.polys) polys.push(poly); } }
  for (const n of (d.cityAdd || [])) { const u = byName[n]; if (u) for (const poly of u.polys) polys.push(poly); }
  for (const ring of d.extra) polys.push([ring]);
  let merged; try { merged = pc.union(polys); } catch (e) { console.log('UNION FAIL', d.id, e.message); merged = polys; }
  const shape = [];
  for (const poly of merged) {
    const rings = [];
    for (const ring of poly) {
      const s = simplify(ring, TOL);
      if (s.length < 4 || ringArea(s) < MIN_AREA) continue;
      if (s[0][0] !== s[s.length - 1][0] || s[0][1] !== s[s.length - 1][1]) s.push(s[0]);
      rings.push(r4(s));
    }
    if (rings.length) shape.push(rings);
  }
  out[d.id] = shape;
}

const js = '/* 政权外轮廓（自动生成，勿手工编辑；见 tools/build-shape.js）\n * 由 geo-city 市界 + dynasties.extra 做多边形并集，仅描外边界（无内部网格）。\n * 键为政权 id，值为 MultiPolygon: [ [外环, ...内环], ... ]。\n */\nwindow.GEO_SHAPE = ' + JSON.stringify(out) + ';\n';
fs.writeFileSync(OUT, js);
console.log('写出', OUT, (js.length / 1024).toFixed(0) + 'KB');
