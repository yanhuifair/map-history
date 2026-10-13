/* 抓取全国县级（县 / 区 / 旗 / 自治州县级）边界到 tools/raw-county/
 * 用法：node tools/fetch-geo-county.js
 * 数据源：DataV.GeoAtlas {adcode}_full.json（返回该单位全部下级）
 * 说明：直辖市（京津沪渝港澳）的省级文件本身就是区级，直接复制；
 *       台湾省在 DataV 无下级数据，沿用省级整块（build-shape 从 prov_index 取）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RAW = path.join(ROOT, 'tools', 'raw');
const PROV_IDX = path.join(ROOT, 'tools', 'prov_index.json');
const OUT = path.join(ROOT, 'tools', 'raw-county');
const MUNI = [110000, 120000, 310000, 500000, 810000, 820000]; // 直辖市/港澳：省级文件即区级

fs.mkdirSync(OUT, { recursive: true });

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(s => setTimeout(s, 600 * (i + 1)));
    }
  }
}

(async () => {
  // 1) 直辖市/港澳：省级文件本身就是区级，直接复制
  for (const code of MUNI) {
    const src = path.join(RAW, code + '.json');
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, code + '.json'));
  }
  console.log('直辖市/港澳复制完成');

  // 2) 各省文件 -> 地级单位列表
  const pres = [];
  for (const f of fs.readdirSync(RAW)) {
    const code = +f.replace('.json', '');
    if (!code || MUNI.includes(code)) continue;
    const j = JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
    for (const ft of j.features) {
      if (ft.properties.childrenNum) pres.push(ft.properties.adcode);
    }
  }
  console.log('待抓取地级单位:', pres.length);

  // 3) 并发抓取
  let done = 0, fail = 0;
  const queue = pres.slice();
  async function worker() {
    while (queue.length) {
      const ad = queue.shift();
      const file = path.join(OUT, ad + '.json');
      if (fs.existsSync(file)) { done++; continue; }
      try {
        const j = await getJSON('https://geo.datav.aliyun.com/areas_v3/bound/' + ad + '_full.json');
        fs.writeFileSync(file, JSON.stringify(j));
        done++;
        if (done % 40 === 0) console.log('进度', done, '/', pres.length);
      } catch (e) {
        fail++;
        console.log('FAIL', ad, e.message);
        queue.push(ad); // 重试一次后放弃策略：放回队尾（最多自然重试 3 次由 getJSON 保证）
        if (fail > 60) { console.log('失败过多，中止'); process.exit(1); }
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log('完成：', done, '个文件，失败', fail, '个；输出目录', OUT);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
