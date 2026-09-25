/* =============================================================
 * Map2D —— 等距圆柱（Plate Carrée）二维历史疆域地图
 * 底图层（海洋 / 世界陆地 / 经纬网 / 省界）只绘制一次并缓存；
 * 疆域层按需重绘（仅在政权集合变化时），避免逐帧重画大纹理。
 *
 * 对外接口与旧版 Globe 保持一致，app.js 无需大改：
 *   new Globe({container, onFrame})
 *   setPolities / setLayer / flyTo / project / focusChina / zoom
 *   getAutoRotate / setAutoRotate / container
 * ============================================================= */
(function () {
  var DEG = Math.PI / 180;
  // 标准纬线：地图以中国（北纬 35° 附近）为中心，x 方向按 cos(35°) 校正，
  // 否则裸等距圆柱会把中高纬疆域横向拉伸 1/cos(φ) 倍（中国显得过宽）。
  var TEX_W = 4096, STD_LAT = 35;
  var TEX_H = Math.round(TEX_W / (2 * Math.cos(STD_LAT * DEG)));  // ≈2501

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function Globe(opts) {
    var container = opts.container;
    var self = this;

    // ---------- 可见 2D 画布 ----------
    var canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);
    var ctx = canvas.getContext('2d');

    // ---------- 离屏贴图画布（等距圆柱，与地理数据同坐标系） ----------
    var baseCanvas = document.createElement('canvas');
    baseCanvas.width = TEX_W; baseCanvas.height = TEX_H;
    var bctx = baseCanvas.getContext('2d');

    var texCanvas = document.createElement('canvas');
    texCanvas.width = TEX_W; texCanvas.height = TEX_H;
    var tctx = texCanvas.getContext('2d');

    // ---------- 视图状态（map 像素 / 经纬度 / 缩放） ----------
    var view = { lng: 105, lat: 34, scale: 1 };    // 当前
    var target = { lng: 105, lat: 34, scale: 1 };  // 目标（平滑跟随）
    var minScale = 0.25, maxScale = 6;
    var autoRotate = false;
    var showProvince = true, showGrid = true;
    var dragging = false, lastX = 0, lastY = 0, lastInteract = 0;
    var needsRedraw = true;
    var inited = false;

    // ---------- 数据 ----------
    var GEO = window.GEO_BASE;
    var provByName = {};
    for (var i = 0; i < GEO.provinces.length; i++) provByName[GEO.provinces[i].n] = GEO.provinces[i];

    var dynProvCache = {};   // 省名 -> Path2D
    var dynPolyCache = {};   // 政权 id -> Path2D
    var currentKey = '';
    var currentPolities = [];
    var baseKey = '';

    // ---------- 投影工具（贴图像素空间） ----------
    function px(lng) { return (lng + 180) / 360 * TEX_W; }
    function py(lat) { return (90 - lat) / 180 * TEX_H; }
    function mapX(lng) { return (lng + 180) / 360 * TEX_W; }
    function mapY(lat) { return (90 - lat) / 180 * TEX_H; }

    function pathFromRings(rings) {
      var p = new Path2D();
      for (var i = 0; i < rings.length; i++) {
        var r = rings[i];
        if (r.length < 3) continue;
        p.moveTo(px(r[0][0]), py(r[0][1]));
        for (var j = 1; j < r.length; j++) p.lineTo(px(r[j][0]), py(r[j][1]));
        p.closePath();
      }
      return p;
    }

    function getProvPath(name) {
      if (dynProvCache[name]) return dynProvCache[name];
      var pr = provByName[name];
      var p = pr ? pathFromRings(pr.p) : null;
      dynProvCache[name] = p;
      return p;
    }

    // 环的有符号面积（canvas 坐标 y 向下）。DataV 省界外环符号恒为负，
    // 手工 extra 环若为正（与省界相反），nonzero 填充下重叠区 winding 相消 = 0，
    // 会渲染出「空心大圈」——因此必须把 extra 环统一成与省界相同的绕向。
    function ringSign(ring) {
      var s = 0;
      for (var i = 0; i < ring.length; i++) {
        var a = ring[i], b = ring[(i + 1) % ring.length];
        s += px(a[0]) * py(b[1]) - px(b[0]) * py(a[1]);
      }
      return s;
    }

    function getPolityPath(d) {
      if (dynPolyCache[d.id]) return dynPolyCache[d.id];
      var p = new Path2D();
      for (var i = 0; i < d.provNames.length; i++) {
        var pp = getProvPath(d.provNames[i]);
        if (pp) p.addPath(pp);
      }
      for (var k = 0; k < d.extra.length; k++) {
        var ring = d.extra[k];
        if (ring.length < 3) continue;
        if (ringSign(ring) > 0) ring = ring.slice().reverse();
        p.moveTo(px(ring[0][0]), py(ring[0][1]));
        for (var j = 1; j < ring.length; j++) p.lineTo(px(ring[j][0]), py(ring[j][1]));
        p.closePath();
      }
      dynPolyCache[d.id] = p;
      return p;
    }

    // ---------- 底图绘制 ----------
    function drawBase() {
      var c = bctx;
      c.clearRect(0, 0, TEX_W, TEX_H);

      // 海洋
      var g = c.createLinearGradient(0, 0, 0, TEX_H);
      g.addColorStop(0, '#07162b');
      g.addColorStop(0.5, '#0a1f3a');
      g.addColorStop(1, '#07162b');
      c.fillStyle = g;
      c.fillRect(0, 0, TEX_W, TEX_H);

      // 经纬网
      if (showGrid) {
        c.lineWidth = Math.max(1, TEX_W / 2000);
        c.strokeStyle = 'rgba(140,170,210,0.10)';
        for (var lng = -180; lng <= 180; lng += 15) {
          c.beginPath(); c.moveTo(px(lng), 0); c.lineTo(px(lng), TEX_H); c.stroke();
        }
        for (var lat = -75; lat <= 75; lat += 15) {
          c.beginPath(); c.moveTo(0, py(lat)); c.lineTo(TEX_W, py(lat)); c.stroke();
        }
        c.strokeStyle = 'rgba(160,190,230,0.20)';
        c.beginPath(); c.moveTo(0, py(0)); c.lineTo(TEX_W, py(0)); c.stroke();
      }

      // 世界陆地（仅作背景，不含任何国界）
      var land = GEO.world;
      c.lineWidth = Math.max(1, TEX_W / 2200);
      c.strokeStyle = 'rgba(110,140,180,0.45)';
      c.fillStyle = '#16202f';
      for (var i = 0; i < land.length; i++) {
        var r = land[i];
        if (r.length < 3) continue;
        // 跳过南极洲（等距圆柱投影下会横跨整幅底部）
        var maxLat = -90;
        for (var q = 0; q < r.length; q++) if (r[q][1] > maxLat) maxLat = r[q][1];
        if (maxLat < -55) continue;
        c.beginPath();
        c.moveTo(px(r[0][0]), py(r[0][1]));
        for (var j = 1; j < r.length; j++) c.lineTo(px(r[j][0]), py(r[j][1]));
        c.closePath();
        c.fill(); c.stroke();
      }

      // 中国省级参考底图（以省界数据填充，保证海岸线与世界底图的差异以省界为准）
      if (showProvince) {
        c.lineWidth = Math.max(1, TEX_W / 3000);
        c.strokeStyle = 'rgba(150,175,210,0.30)';
        c.fillStyle = '#1b2739';
        for (var k = 0; k < GEO.provinces.length; k++) {
          var rings = GEO.provinces[k].p;
          for (var m = 0; m < rings.length; m++) {
            var rr = rings[m];
            if (rr.length < 3) continue;
            c.beginPath();
            c.moveTo(px(rr[0][0]), py(rr[0][1]));
            for (var n = 1; n < rr.length; n++) c.lineTo(px(rr[n][0]), py(rr[n][1]));
            c.closePath();
            c.fill();
            c.stroke();
          }
        }
      }
      baseKey = (showGrid ? 'g' : '') + (showProvince ? 'p' : '');
    }

    // ---------- 疆域层绘制 ----------
    function drawTerritories(polities) {
      var c = tctx;
      c.clearRect(0, 0, TEX_W, TEX_H);
      c.drawImage(baseCanvas, 0, 0);

      // 低层级政权先画，主体王朝压在上层
      var list = polities.slice().sort(function (a, b) { return b.level - a.level; });
      var lw = Math.max(1.5, TEX_W / 1900);

      for (var i = 0; i < list.length; i++) {
        var d = list[i];
        var path = getPolityPath(d);
        var alpha = d.level === 1 ? 0.42 : (d.level === 2 ? 0.34 : 0.28);

        // 外发光
        c.save();
        c.globalAlpha = 0.55;
        c.shadowColor = d.color;
        c.shadowBlur = TEX_W / 90;
        c.strokeStyle = d.color;
        c.lineWidth = lw * 1.4;
        c.stroke(path);
        c.restore();

        // 填充
        c.save();
        c.globalAlpha = alpha;
        c.fillStyle = d.color;
        c.fill(path);
        c.restore();

        // 边界
        c.save();
        c.globalAlpha = 0.95;
        c.strokeStyle = d.color;
        c.lineWidth = lw;
        c.lineJoin = 'round';
        c.stroke(path);
        c.restore();
      }

      // 南海诸岛（九段线）—— 中国领有南海诸岛时才绘制
      var hasChina = false;
      for (var z = 0; z < polities.length; z++) {
        if (polities[z].id === 'prc' || polities[z].id === 'roc1' || polities[z].id === 'roc2') hasChina = true;
      }
      if (hasChina && GEO.nanhai && GEO.nanhai.length) {
        c.save();
        c.strokeStyle = 'rgba(230,200,140,0.95)';
        c.lineWidth = lw * 1.6;
        c.lineCap = 'round';
        for (var q = 0; q < GEO.nanhai.length; q++) {
          var line = GEO.nanhai[q];
          if (line.length < 2) continue;
          c.beginPath();
          c.moveTo(px(line[0][0]), py(line[0][1]));
          for (var w = 1; w < line.length; w++) c.lineTo(px(line[w][0]), py(line[w][1]));
          c.stroke();
        }
        c.restore();
      }

      // 都城标记
      for (var k = 0; k < list.length; k++) {
        var dd = list[k];
        if (!dd.cap) continue;
        var x = px(dd.cap.lng), y = py(dd.cap.lat);
        var R = TEX_W / 500;
        c.save();
        c.globalAlpha = 0.30;
        c.fillStyle = '#ffffff';
        c.beginPath(); c.arc(x, y, R * 2.6, 0, Math.PI * 2); c.fill();
        c.restore();
        c.save();
        c.fillStyle = '#ffe9b0';
        c.strokeStyle = '#7a4a10';
        c.lineWidth = lw * 0.9;
        c.beginPath(); c.arc(x, y, R, 0, Math.PI * 2); c.fill(); c.stroke();
        c.restore();
      }
      needsRedraw = true;
    }

    // ---------- 对外接口 ----------
    self.setPolities = function (polities) {
      currentPolities = polities;
      var key = '';
      for (var i = 0; i < polities.length; i++) key += polities[i].id + ',';
      var bk = (showGrid ? 'g' : '') + (showProvince ? 'p' : '');
      if (bk !== baseKey) { drawBase(); currentKey = ''; }
      if (key !== currentKey) { currentKey = key; drawTerritories(polities); }
      else needsRedraw = true;
    };

    self.setLayer = function (name, on) {
      if (name === 'province') showProvince = on; else if (name === 'grid') showGrid = on;
      drawBase();
      drawTerritories(currentPolities);
    };

    self.setAutoRotate = function (on) { autoRotate = on; lastInteract = performance.now(); };
    self.getAutoRotate = function () { return autoRotate; };

    self.focusChina = function () {
      fitChina();
      lastInteract = performance.now();
    };
    // 飞向指定经纬度（用于点击都城 / 政权后居中）
    self.flyTo = function (lng, lat) {
      // 归一化到与当前视角最近的等价经度，避免绕远路
      var t = target.lng;
      while (lng - t > 180) lng -= 360;
      while (t - lng > 180) lng += 360;
      target.lng = lng;
      target.lat = clamp(lat, -80, 80);
      lastInteract = performance.now();
    };
    self.zoom = function (f) {
      target.scale = clamp(target.scale * f, minScale, maxScale);
      lastInteract = performance.now();
    };

    // 经纬度 -> 屏幕坐标（用于 HTML 标签叠加；屏幕坐标与 #stage 同系）
    self.project = function (lng, lat) {
      var w = canvas.clientWidth, h = canvas.clientHeight;
      var sx = w / 2 + (mapX(lng) - mapX(view.lng)) * view.scale;
      var sy = h / 2 + (mapY(lat) - mapY(view.lat)) * view.scale;
      var visible = sx >= 0 && sx <= w && sy >= 0 && sy <= h;
      return { x: sx, y: sy, visible: visible };
    };

    // ---------- 尺寸 ----------
    function resize() {
      var w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw; canvas.height = bh;
        needsRedraw = true;
      }
      minScale = Math.min(w / TEX_W, h / TEX_H) * 0.95;   // 可缩放至完整显示全球（宽、高同时容纳）
      if (maxScale < minScale * 4) maxScale = minScale * 4;
      if (!inited) { fitChina(); inited = true; }
    }

    function fitChina() {
      var w = canvas.clientWidth || container.clientWidth;
      var h = canvas.clientHeight || container.clientHeight;
      if (!w || !h) return;
      target.lng = 105; target.lat = 34;
      var sw = w / (100 / 360 * TEX_W);   // 横向容纳约 100°
      var sh = h / (60 / 180 * TEX_H);    // 纵向容纳约 60°
      target.scale = Math.min(sw, sh) * 0.96;
      target.scale = clamp(target.scale, minScale, maxScale);
    }

    // ---------- 渲染 ----------
    function render() {
      var w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // 背景（海洋外留白区域）
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#04060c';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      var tx = (w / 2 - mapX(view.lng) * view.scale) * dpr;
      var ty = (h / 2 - mapY(view.lat) * view.scale) * dpr;
      ctx.setTransform(view.scale * dpr, 0, 0, view.scale * dpr, tx, ty);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(texCanvas, 0, 0);

      // 轻量边框（地图边缘提示）
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // ---------- 交互 ----------
    canvas.addEventListener('pointerdown', function (e) {
      dragging = true; canvas.style.cursor = 'grabbing';
      lastX = e.clientX; lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      lastInteract = performance.now();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      // 内容跟随手指：拖动多少屏幕像素，中心就反向移动等量的经度/纬度
      var dLng = dx / (view.scale * (TEX_W / 360));
      var dLat = dy / (view.scale * (TEX_H / 180));
      target.lng -= dLng;
      target.lat = clamp(target.lat + dLat, -85, 85);
      lastInteract = performance.now();
    });
    canvas.addEventListener('pointerup', function (e) {
      dragging = false; canvas.style.cursor = 'grab';
      lastInteract = performance.now();
    });
    canvas.addEventListener('pointercancel', function () {
      dragging = false; canvas.style.cursor = 'grab';
    });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var w = canvas.clientWidth, h = canvas.clientHeight;
      var rect = canvas.getBoundingClientRect();
      var sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      var factor = e.deltaY > 0 ? 0.9 : 1.1;
      var newScale = clamp(target.scale * factor, minScale, maxScale);
      // 以光标为锚点缩放：缩放前后光标下的地图点保持不变
      var mapXc = (sx - w / 2) / target.scale + mapX(target.lng);
      var mapYc = (sy - h / 2) / target.scale + mapY(target.lat);
      target.lng = (mapXc - (sx - w / 2) / newScale) * 360 / TEX_W - 180;
      target.lat = 90 - (mapYc - (sy - h / 2) / newScale) * 180 / TEX_H;
      target.lat = clamp(target.lat, -85, 85);
      target.scale = newScale;
      lastInteract = performance.now();
    }, { passive: false });

    window.addEventListener('resize', resize);

    // ---------- 主循环 ----------
    function tick() {
      requestAnimationFrame(tick);
      resize();

      // 平滑跟随
      var moving = false;
      view.lng += (target.lng - view.lng) * 0.22;
      view.lat += (target.lat - view.lat) * 0.22;
      view.scale += (target.scale - view.scale) * 0.22;
      if (Math.abs(target.lng - view.lng) > 0.002 ||
          Math.abs(target.lat - view.lat) > 0.002 ||
          Math.abs(target.scale - view.scale) > 0.0005) moving = true;

      // 自动漂移（仅在启用且空闲时）
      if (autoRotate && !dragging && !moving && performance.now() - lastInteract > 1500) {
        target.lng += 0.06;
        moving = true;
      }

      if (moving || needsRedraw) { render(); needsRedraw = false; }
      if (opts.onFrame) opts.onFrame();
    }

    drawBase();
    resize();
    fitChina();
    view.lng = target.lng; view.lat = target.lat; view.scale = target.scale;
    tick();
    self.container = container;
  }

  window.Globe = Globe;
})();
