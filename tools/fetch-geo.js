// 抓取 DataV.GeoAtlas 省 / 市级边界原始数据到 ./raw（供 build-shape.js 使用）
// 用法：node tools/fetch-geo.js
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'raw');
fs.mkdirSync(OUT, { recursive: true });

async function getJSON(url) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    catch (e) { if (i === 2) throw e; await new Promise(s => setTimeout(s, 800)); }
  }
}

(async () => {
  const idx = await getJSON('https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json');
  fs.writeFileSync(path.join(__dirname, 'prov_index.json'), JSON.stringify(idx));
  const provs = idx.features.map(f => ({ adcode: f.properties.adcode, name: f.properties.name, childrenNum: f.properties.childrenNum }));
  for (const p of provs) {
    if (!p.childrenNum) continue;   // 台湾省无下级；直辖市/港澳的区级不逐个使用
    const file = path.join(OUT, p.adcode + '.json');
    if (fs.existsSync(file)) continue;
    try {
      const j = await getJSON('https://geo.datav.aliyun.com/areas_v3/bound/' + p.adcode + '_full.json');
      fs.writeFileSync(file, JSON.stringify(j));
      console.log('ok', p.name, (j.features || []).length);
    } catch (e) { console.log('FAIL', p.name, e.message); }
  }
  console.log('完成：原始数据在', OUT);
})();
