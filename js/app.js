/* =============================================================
 * App —— 主控逻辑：时间轴 <-> 球体 <-> 信息面板
 * ============================================================= */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var D = window.DYNASTIES;

  // 新中国：结束年跟随当前年份
  var prc = null;
  for (var i = 0; i < D.length; i++) if (D[i].id === 'prc') prc = D[i];
  if (prc) prc.end = new Date().getFullYear();

  var minY = -2150, maxY = Math.max(2030, (prc ? prc.end : 2026) + 4);

  var year = -2070;
  var playing = false;
  var speeds = [30, 80, 200], speedIdx = 1;
  var lastTs = 0;
  var labels = {};

  // ---------- 球体 ----------
  var globe = new Globe({
    container: $('globe'),
    onFrame: onFrame
  });

  // ---------- 时间轴 ----------
  var timeline = new Timeline({
    canvas: $('timeline'),
    polities: D,
    minYear: minY,
    maxYear: maxY,      // 视图/坐标轴可到 maxY（留边）
    yearMax: maxY - 4,  // 年份可选上限，与下方 setYear 的钳制一致
    // 时间轴自身发起的年份变化：标记 fromTimeline=true，避免 app 再回灌 timeline.setYear
    // （否则会绕过 y===year 早退并触发自动居中/缩放）
    onChange: function (y) { setYear(y, true); },
    onHover: onHoverTip
  });

  // ---------- 工具函数 ----------
  function activeAt(y) {
    var out = [];
    for (var i = 0; i < D.length; i++) {
      var d = D[i];
      if (y >= d.start && y <= d.end) out.push(d);
    }
    return out;
  }

  function mainOf(list) {
    if (!list.length) return null;
    // 主体王朝优先；同级取「最新建立」的政权（如 220 年取魏而非东汉）
    var s = list.slice().sort(function (a, b) {
      if (a.level !== b.level) return a.level - b.level;
      return b.start - a.start;
    });
    return s[0];
  }

  function spanText(d) {
    var a = d.start < 0 ? '前' + (-d.start) : '' + d.start;
    var b = d.end >= maxY - 5 ? '今' : (d.end < 0 ? '前' + (-d.end) : '' + d.end);
    return a + ' — ' + b;
  }

  function yearText(y) {
    if (y < 0) return '公元前 ' + (-y) + ' 年';
    return '公元 ' + y + ' 年';
  }

  // ---------- 标签叠加 ----------
  var labelLayer = $('labels');
  function syncLabels(list) {
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (!d.cap) continue;
      seen[d.id] = 1;
      var el = labels[d.id];
      if (!el) {
        el = document.createElement('div');
        el.className = 'cap-label';
        // 政权名已由「区域标签」标注在辖区中央，此处只显示都城名
        el.innerHTML = '<i style="background:' + d.color + '"></i><span>' + d.cap.n + '</span>';
        el.addEventListener('click', function (d) {
          return function () { globe.flyTo(d.cap.lng, d.cap.lat); };
        }(d));
        labelLayer.appendChild(el);
        labels[d.id] = el;
      }
    }
    for (var id in labels) {
      if (!seen[id]) { labelLayer.removeChild(labels[id]); delete labels[id]; }
    }
  }

  function updateLabelPositions() {
    for (var id in labels) {
      var el = labels[id];
      var d = findById(id);
      if (!d || !d.cap) continue;
      var p = globe.project(d.cap.lng, d.cap.lat);
      el.style.transform = 'translate3d(' + (p.x + 8) + 'px,' + (p.y - 10) + 'px,0)';
      el.style.opacity = p.visible ? '1' : '0';
      el.style.pointerEvents = p.visible ? 'auto' : 'none';
    }
  }

  function findById(id) {
    for (var i = 0; i < D.length; i++) if (D[i].id === id) return D[i];
    return null;
  }

  // ---------- 区域标签（政权名标注在辖区中央） ----------
  // 由预计算轮廓求「面积最大多边形」的质心作为标注点，并记录外接框用于屏幕尺寸判断。
  var SHAPE = window.GEO_SHAPE || {};
  var labelPt = {}, labelBox = {};
  (function () {
    for (var id in SHAPE) {
      var polys = SHAPE[id];
      if (!polys || !polys.length) continue;
      var bestPt = null, bestA = 0;
      var box = { minLng: 999, maxLng: -999, minLat: 999, maxLat: -999 };
      for (var i = 0; i < polys.length; i++) {
        var ring = polys[i][0];
        if (!ring || ring.length < 3) continue;
        var a = 0, cx = 0, cy = 0;
        for (var j = 0; j < ring.length; j++) {
          var p = ring[j], q = ring[(j + 1) % ring.length];
          var f = p[0] * q[1] - q[0] * p[1];
          a += f; cx += (p[0] + q[0]) * f; cy += (p[1] + q[1]) * f;
          if (p[0] < box.minLng) box.minLng = p[0];
          if (p[0] > box.maxLng) box.maxLng = p[0];
          if (p[1] < box.minLat) box.minLat = p[1];
          if (p[1] > box.maxLat) box.maxLat = p[1];
        }
        a /= 2;
        if (Math.abs(a) > bestA) { bestA = Math.abs(a); bestPt = [cx / (6 * a), cy / (6 * a)]; }
      }
      if (bestPt) { labelPt[id] = bestPt; labelBox[id] = box; }
    }
  })();

  var regionLabels = {};
  function syncRegionLabels(list) {
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (!labelPt[d.id]) continue;
      seen[d.id] = 1;
      var el = regionLabels[d.id];
      if (!el) {
        el = document.createElement('div');
        el.className = 'region-label';
        el.textContent = d.name;
        el.style.color = d.color;
        labelLayer.appendChild(el);
        regionLabels[d.id] = el;
      }
    }
    for (var id in regionLabels) {
      if (!seen[id]) { labelLayer.removeChild(regionLabels[id]); delete regionLabels[id]; }
    }
  }

  function updateRegionPositions() {
    for (var id in regionLabels) {
      var el = regionLabels[id];
      var pt = labelPt[id], box = labelBox[id];
      if (!pt) continue;
      var p = globe.project(pt[0], pt[1]);
      // 区域内屏幕尺寸太小则不标注，避免杂乱
      var c1 = globe.project(box.minLng, box.minLat), c2 = globe.project(box.maxLng, box.maxLat);
      var big = Math.abs(c2.x - c1.x) > 44 || Math.abs(c2.y - c1.y) > 30;
      el.style.opacity = (p.visible && big) ? '1' : '0';
      el.style.transform = 'translate3d(' + p.x + 'px,' + p.y + 'px,0) translate(-50%,-50%)';
    }
  }

  // ---------- 信息面板 ----------
  function renderPanel(list) {
    $('year-big').textContent = year < 0 ? '前 ' + (-year) : '' + year;
    $('year-sub').textContent = yearText(year);

    var main = mainOf(list);
    var box = $('panel-main');
    if (!main) {
      box.innerHTML = '<div class="empty">该年份暂无收录政权<br><span>拖动下方时间轴探索</span></div>';
    } else {
      var others = list.filter(function (d) { return d !== main; })
        .sort(function (a, b) { return a.level - b.level || a.start - b.start; });
      var html = '';
      html += '<div class="pm-head"><span class="dot" style="background:' + main.color + '"></span>' +
        '<h2>' + main.name + '</h2><span class="lv">' + (main.level === 1 ? '主体王朝' : main.level === 2 ? '区域政权' : '割据 / 边疆政权') + '</span></div>';
      html += '<div class="pm-meta"><div><label>起止</label><p>' + spanText(main) + '</p></div>' +
        '<div><label>都城</label><p>' + (main.cap ? main.cap.n : '—') + '</p></div>' +
        (main.peak ? '<div><label>极盛疆域</label><p>' + main.peak + '</p></div>' : '') + '</div>';
      html += '<p class="pm-desc">' + main.desc + '</p>';
      if (others.length) {
        html += '<div class="pm-others"><label>同时并存（' + others.length + '）</label><div class="chips">';
        for (var i = 0; i < others.length; i++) {
          html += '<span class="chip" data-id="' + others[i].id + '" style="--c:' + others[i].color + '">' + others[i].name + '</span>';
        }
        html += '</div></div>';
      }
      box.innerHTML = html;
      var chips = box.querySelectorAll('.chip');
      for (var c = 0; c < chips.length; c++) {
        chips[c].addEventListener('click', function (e) {
          var d = findById(e.target.getAttribute('data-id'));
          if (d && d.cap) globe.flyTo(d.cap.lng, d.cap.lat);
        });
      }
    }
  }

  // ---------- 年份切换 ----------
  function setYear(y, fromTimeline) {
    y = Math.round(y);
    if (y < minY) y = minY;
    if (y > maxY - 4) y = maxY - 4;
    year = y;
    if (!fromTimeline) timeline.setYear(y);

    var list = activeAt(y);
    globe.setPolities(list);
    syncLabels(list);
    syncRegionLabels(list);
    renderPanel(list);
    markChips(list);
  }

  // ---------- 朝代胶囊 ----------
  var chipBox = $('chips-row');
  (function buildChips() {
    var mains = D.filter(function (d) { return d.level === 1; })
      .sort(function (a, b) { return a.start - b.start; });
    var html = '';
    for (var i = 0; i < mains.length; i++) {
      var d = mains[i];
      html += '<button class="era" data-start="' + d.start + '" data-end="' + d.end + '" style="--c:' + d.color + '">' + d.name + '</button>';
    }
    chipBox.innerHTML = html;
    var btns = chipBox.querySelectorAll('.era');
    for (var j = 0; j < btns.length; j++) {
      btns[j].addEventListener('click', function (e) {
        var s = +e.target.getAttribute('data-start'), en = +e.target.getAttribute('data-end');
        var target = s + Math.round((en - s) * 0.35);
        pause();
        timeline.zoomTo(s, en);
        setYear(target);
      });
    }
  })();

  function markChips(list) {
    var ids = {};
    for (var i = 0; i < list.length; i++) ids[list[i].name] = 1;
    var btns = chipBox.querySelectorAll('.era');
    for (var j = 0; j < btns.length; j++) {
      btns[j].classList.toggle('on', !!ids[btns[j].textContent]);
    }
  }

  // ---------- 播放 ----------
  function play() {
    playing = true;
    $('btn-play').textContent = '⏸';
    $('btn-play').classList.add('on');
    lastTs = performance.now();
  }
  function pause() {
    playing = false;
    $('btn-play').textContent = '▶';
    $('btn-play').classList.remove('on');
  }
  function jump(dir) {
    // 跳到相邻政权起点
    var marks = [];
    for (var i = 0; i < D.length; i++) marks.push(D[i].start);
    marks.sort(function (a, b) { return a - b; });
    for (var j = 0; j < marks.length; j++) {
      if (dir > 0 && marks[j] > year) { setYear(marks[j]); return; }
    }
    if (dir > 0) { setYear(maxY - 4); return; }
    for (var k = marks.length - 1; k >= 0; k--) {
      if (marks[k] < year) { setYear(marks[k]); return; }
    }
    setYear(minY);
  }

  $('btn-play').addEventListener('click', function () { playing ? pause() : play(); });
  $('btn-prev').addEventListener('click', function () { pause(); jump(-1); });
  $('btn-next').addEventListener('click', function () { pause(); jump(1); });
  $('btn-reset').addEventListener('click', function () { pause(); timeline.resetView(); setYear(-2070); });
  var spBtn = $('btn-speed');
  spBtn.addEventListener('click', function () {
    speedIdx = (speedIdx + 1) % speeds.length;
    spBtn.textContent = '×' + [1, 2, 4][speedIdx];
  });

  // ---------- 图层 / 视角 ----------
  function toggle(id, key, init) {
    var btn = $(id), on = init;
    btn.classList.toggle('on', on);
    btn.addEventListener('click', function () {
      on = !on;
      btn.classList.toggle('on', on);
      globe.setLayer(key, on);
    });
  }
  toggle('t-province', 'province', true);
  toggle('t-grid', 'grid', true);
  var rotBtn = $('t-rotate');
  rotBtn.classList.toggle('on', globe.getAutoRotate());
  rotBtn.addEventListener('click', function () {
    var on = !globe.getAutoRotate();
    globe.setAutoRotate(on);
    rotBtn.classList.toggle('on', on);
  });
  $('t-home').addEventListener('click', function () { globe.focusChina(); });
  $('t-in').addEventListener('click', function () { globe.zoom(0.82); });
  $('t-out').addEventListener('click', function () { globe.zoom(1.22); });

  // ---------- 提示气泡 ----------
  var tip = $('tip');
  function onHoverTip(d, p) {
    if (!d || !p) { tip.style.display = 'none'; return; }
    tip.style.display = 'block';
    tip.innerHTML = '<b style="color:' + d.color + '">' + d.name + '</b>' +
      '<span>' + spanText(d) + '</span>' +
      (d.cap ? '<span class="muted">' + d.cap.n + '</span>' : '');
    var rect = $('timeline').getBoundingClientRect();
    var x = rect.left + p.x;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - 210, x)) + 'px';
    tip.style.top = (rect.top - 8 - tip.offsetHeight) + 'px';
  }

  // ---------- 键盘 ----------
  window.addEventListener('keydown', function (e) {
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') { pause(); setYear(year - (e.shiftKey ? 20 : 1)); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { pause(); setYear(year + (e.shiftKey ? 20 : 1)); e.preventDefault(); }
    else if (e.code === 'Space') { playing ? pause() : play(); e.preventDefault(); }
    else if (e.key === 'Home') { pause(); setYear(minY); }
    else if (e.key === 'End') { pause(); setYear(maxY - 4); }
  });

  // ---------- 帧循环 ----------
  function onFrame() {
    if (playing) {
      var now = performance.now();
      var dt = Math.min(120, now - lastTs);
      lastTs = now;
      var ny = year + speeds[speedIdx] * dt / 1000;
      if (ny >= maxY - 4) { ny = maxY - 4; pause(); }
      setYear(ny);
    }
    updateLabelPositions();
    updateRegionPositions();
  }

  // ---------- 启动 ----------
  // 支持 URL 参数 ?year=1820 直接定位（便于分享链接与自动化测试）
  var qs = location.search.match(/[?&]year=(-?\d+)/);
  setYear(qs ? +qs[1] : -2070);
  // 调试用入口（控制台可直接 window.__setYear(618)）
  window.__setYear = setYear;
  window.__app = { get year() { return year; }, timeline: timeline, globe: globe };
  window.addEventListener('resize', function () { timeline.render(); });
})();
