# Map History — China Historical Territory Map

[中文说明](readme-zh.md)

A single-page interactive visualization of **all major states and dynasties in Chinese history** (Xia, c. 2070 BC → today), rendered on an interactive **2D map** with a **draggable timeline**.

![tech](https://img.shields.io/badge/stack-Canvas%202D-blue) ![license](https://img.shields.io/badge/license-AGPL--3.0-green)

## Features

- **2D world map** (equirectangular Canvas with standard parallel at 35°N, no external map library): drag to pan, wheel to zoom (anchored at cursor), optional slow drift. True-to-shape proportions for China instead of the stretched look of a plain Plate Carrée.
- **Timeline scrubber** at the bottom: drag / click any year; the territory on the map changes with the timeline.
  - Upper thick band: major unified dynasties; thin bands below: regional / fragmented / frontier regimes.
  - Mouse wheel zooms the time axis; drag the axis to pan; click a dynasty block to jump.
- **Playback**: play / pause, 1× / 2× / 4× speed, prev/next regime, keyboard (`←/→` step years, `Shift` ×20, `Space` play, `Home/End`).
- **82 polities** from Xia to the PRC: unified dynasties, Warring States, Three Kingdoms, Sixteen Kingdoms, Northern & Southern Dynasties, Five Dynasties & Ten Kingdoms, Liao/Song/Xia/Jin, steppe empires (Xiongnu, Rouran, Türk, Uyghurs), Yuan / Ming / Qing / ROC / PRC.
- **Info panel** for the current year: polity, reign dates, capital, peak territory, short description, coexisting regimes.
- **Capital labels** overlaid on the map (hidden while off-screen); click a label or badge to fly the map there.
- **Standards-compliant map**: province-level reference basemap includes Taiwan, Hong Kong / Macao and the South China Sea islands (nine-dash line is drawn when China is on the map).

## Territory data model

Each polity is defined in `js/data/dynasties.js` as a set of modern provinces (`prov`), refined by:

- `cityDel` — prefecture-level cities to **subtract** (places inside a listed province the polity did *not* actually control, e.g. the northern Inner Mongolia leagues for the Han, the Huai-north cities for the Southern Song, the far-western Qinghai prefectures for Wei/Jin);
- `cityAdd` — cities to add beyond the listed provinces;
- `extra` — hand-drawn polygons for areas beyond the modern border (`mongolia`, `outerNE`, `centralAsia`, `annam`, `koreaN`, `hexi`, `longyou`, …).

A build step unions each polity's cities + extras into one clean outline (`js/data/geo-shape.js`), so the map fills by **prefecture-level city** for precision while stroking only the outer boundary — no internal city grid. Historical extents are **approximate visualizations**, not boundary claims. The basemap coastline uses Natural Earth 50m land (public domain, no borders), with the China area refilled from province boundaries so coastlines match exactly; China province boundaries come from DataV.GeoAtlas.

## Run

Any static server works:

```bash
python3 -m http.server 8791
# open http://127.0.0.1:8791
```

No build step and no external network requests at runtime — the generated data files are committed.

## Structure

```
index.html               page shell
css/style.css            dark minimal theme
js/data/geo-base.js      generated: world land + China provinces + nine-dash line
js/data/geo-shape.js     generated: per-polity outer outlines (union of cities + extras)
js/data/dynasties.js     polity & territory data (hand-curated)
js/globe.js              2D map rendering (cached equirect base + territory layers)
js/timeline.js           timeline: bands, rows, zoom/pan, scrub
js/app.js                wiring: year → polities → map/panel/labels
tools/fetch-geo.js       fetch DataV province / prefecture boundaries
tools/build-shape.js     union cities + extras → js/data/geo-shape.js
```

Regenerate the territory outlines:

```bash
node tools/fetch-geo.js    # download DataV boundaries into tools/raw (cached)
node tools/build-shape.js  # requires polygon-clipping
```

`geo-base.js` (world land + province basemap) was generated separately from Natural Earth 50m TopoJSON + DataV province boundaries.

## License

[AGPL-3.0](LICENSE)
