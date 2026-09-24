# Map History — China Historical Territory Globe

[中文说明](readme-zh.md)

A single-page interactive visualization of **all major states and dynasties in Chinese history** (Xia, c. 2070 BC → today), rendered on a **3D globe** with a **draggable timeline**.

![tech](https://img.shields.io/badge/stack-Three.js%20%2B%20Canvas%202D-blue) ![license](https://img.shields.io/badge/license-AGPL--3.0-green)

## Features

- **3D globe** (Three.js): drag to rotate, wheel to zoom, gentle auto-rotation, atmospheric glow, starfield.
- **Timeline scrubber** at the bottom: drag / click any year; the territory on the globe changes with the timeline.
  - Upper thick band: major unified dynasties; thin bands below: regional / fragmented / frontier regimes.
  - Mouse wheel zooms the time axis; drag the axis to pan; click a dynasty block to jump.
- **Playback**: play / pause, 1× / 2× / 4× speed, prev/next regime, keyboard (`←/→` step years, `Shift` ×20, `Space` play, `Home/End`).
- **82 polities** from Xia to the PRC: unified dynasties, Warring States, Three Kingdoms, Sixteen Kingdoms, Northern & Southern Dynasties, Five Dynasties & Ten Kingdoms, Liao/Song/Xia/Jin, steppe empires (Xiongnu, Rouran, Türk, Uyghurs), Yuan / Ming / Qing / ROC / PRC.
- **Info panel** for the current year: polity, reign dates, capital, peak territory, short description, coexisting regimes.
- **Capital labels** overlaid on the globe (hidden when on the far side); click a label or badge to fly the globe there.
- **Standards-compliant map**: province-level reference basemap includes Taiwan, Hong Kong / Macao and the South China Sea islands (nine-dash line is drawn when China is on the map).

## Territory data model

Each polity = a set of modern provinces (`prov`) + optional hand-drawn polygons for areas beyond the modern border (`extra`: Mongolian plateau, Outer Manchuria, Central Asia, northern Korea, Jiaozhi/Annam, Hexi corridor, …).

Historical extents are **approximate visualizations** of a polity's main / peak territory — not boundary claims. The basemap coastline uses Natural Earth 110m land (public domain, no borders); China province boundaries come from DataV.GeoAtlas.

## Run

Any static server works:

```bash
python3 -m http.server 8791
# open http://127.0.0.1:8791
```

No build step, no external network requests at runtime (Three.js is vendored in `js/vendor/`).

## Structure

```
index.html              page shell
css/style.css           dark minimal theme
js/vendor/three.min.js  Three.js r128 (vendored)
js/data/geo-base.js     generated: world land + China provinces + nine-dash line
js/data/dynasties.js    polity & territory data (hand-curated)
js/globe.js             globe rendering (equirect canvas texture → sphere)
js/timeline.js          timeline: bands, rows, zoom/pan, scrub
js/app.js               wiring: year → polities → globe/panel/labels
```

To regenerate `geo-base.js`, edit `/tmp/build_geo.py` inputs (province GeoJSON + Natural Earth TopoJSON) and re-run it.

## License

[AGPL-3.0](LICENSE)
