/* =============================================================
 * Timeline —— 可拖动 / 可缩放的历史时间轴
 * 上部粗带：主体王朝（level 1）
 * 中部细带：区域、割据与边疆政权（level 2 / 3），自动分行避免重叠
 * 下部：年份刻度与当前年份指针
 * ============================================================= */
(function () {
  var PAD_L = 16, PAD_R = 16;

  function fmtYear(y) {
    y = Math.round(y);
    if (y < 0) return '前' + (-y);
    if (y === 0) return '0';
    return '' + y;
  }
  function yearLabel(y) {
    y = Math.round(y);
    return y < 0 ? '公元前 ' + (-y) + ' 年' : '公元 ' + y + ' 年';
  }

  function Timeline(opts) {
    var canvas = opts.canvas;
    var ctx = canvas.getContext('2d');
    var polities = opts.polities;
    var self = this;

    var MIN_Y = opts.minYear !== undefined ? opts.minYear : -2150;
    var MAX_Y = opts.maxYear !== undefined ? opts.maxYear : 2030;
    var view = { min: MIN_Y, max: MAX_Y };
    var year = -2070;
    var hover = null;
    var draggingPointer = false, draggingAxis = false, dragStartX = 0, dragStartMin = 0;
    var onChange = opts.onChange || function () { };
    var onHover = opts.onHover || function () { };

    // 预先分组
    var main = [], minor = [];
    for (var i = 0; i < polities.length; i++) {
      (polities[i].level === 1 ? main : minor).push(polities[i]);
    }
    main.sort(function (a, b) { return a.start - b.start; });
    minor.sort(function (a, b) { return a.start - b.start; });

    // 细带行分配（贪心）
    var minorRows = [];
    (function () {
      var rowEnds = [];
      for (var i = 0; i < minor.length; i++) {
        var d = minor[i], placed = false;
        for (var r = 0; r < rowEnds.length; r++) {
          if (d.start > rowEnds[r] + 4) { d._row = r; rowEnds[r] = d.end; placed = true; break; }
        }
        if (!placed) { d._row = rowEnds.length; rowEnds.push(d.end); }
      }
      minorRows = rowEnds;
    })();

    var ROW_MAIN = { y: 10, h: 26 };
    var ROW_MINOR = { y: 42, h: 11, gap: 3 };
    var AXIS_H = 30;

    function layout() {
      var rect = canvas.getBoundingClientRect();
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w: rect.width, h: rect.height };
    }

    function plotW(w) { return w - PAD_L - PAD_R; }
    function x2y(x, w) { return view.min + (x - PAD_L) / plotW(w) * (view.max - view.min); }
    function y2x(y, w) { return PAD_L + (y - view.min) / (view.max - view.min) * plotW(w); }

    function axisTop(h) { return h - AXIS_H; }

    function drawBand(list, y, h, w, withText, fontSize, minTextW) {
      minTextW = minTextW || 34;
      for (var i = 0; i < list.length; i++) {
        var d = list[i];
        var x0 = y2x(d.start, w), x1 = y2x(d.end, w);
        if (x1 < PAD_L - 2 || x0 > w - PAD_R + 2) continue;
        x0 = Math.max(x0, PAD_L); x1 = Math.min(x1, w - PAD_R);
        var bw = Math.max(1.5, x1 - x0);
        var isNow = year >= d.start && year <= d.end;
        var isHover = hover === d;

        ctx.globalAlpha = isNow ? 1 : (isHover ? 0.95 : 0.62);
        ctx.fillStyle = d.color;
        roundRect(x0, y, bw, h, Math.min(4, h / 2));
        ctx.fill();

        if (isNow) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = 'rgba(255,255,255,0.9)';
          ctx.lineWidth = 1.2;
          roundRect(x0 + 0.5, y + 0.5, bw - 1, h - 1, Math.min(4, h / 2));
          ctx.stroke();
        }
        if (withText && bw > minTextW) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = 'rgba(10,14,20,0.88)';
          ctx.font = '600 ' + fontSize + 'px "PingFang SC","Microsoft YaHei",sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          var label = d.name.length > Math.floor(bw / (fontSize + 1)) ? d.name.slice(0, Math.max(1, Math.floor(bw / (fontSize + 1)) - 1)) + '…' : d.name;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0 + 3, y, bw - 6, h);
          ctx.clip();
          ctx.fillText(label, x0 + 5, y + h / 2 + 0.5);
          ctx.restore();
        }
        d._bx0 = x0; d._bx1 = x1; d._by = y; d._bh = h;
      }
      ctx.globalAlpha = 1;
    }

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    function niceStep(span) {
      var candidates = [10, 20, 25, 50, 100, 200, 250, 500, 1000];
      var target = span / 10;
      for (var i = 0; i < candidates.length; i++) if (candidates[i] >= target) return candidates[i];
      return 1000;
    }

    function draw() {
      var L = layout(), w = L.w, h = L.h;
      ctx.clearRect(0, 0, w, h);

      // 背景轨道
      ctx.fillStyle = 'rgba(255,255,255,0.035)';
      roundRect(PAD_L, ROW_MAIN.y, plotW(w), ROW_MAIN.h, 5); ctx.fill();

      drawBand(main, ROW_MAIN.y, ROW_MAIN.h, w, true, 11);
      for (var r = 0; r < minorRows.length; r++) {
        var yy = ROW_MINOR.y + r * (ROW_MINOR.h + ROW_MINOR.gap);
        var row = minor.filter(function (d) { return d._row === r; });
        // 细带空间有限：色块足够宽时才画文字
        drawBand(row, yy, ROW_MINOR.h, w, true, 8.5, 70);
      }

      // 刻度轴
      var ay = axisTop(h);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PAD_L, ay + 0.5); ctx.lineTo(w - PAD_R, ay + 0.5); ctx.stroke();

      var step = niceStep(view.max - view.min);
      var first = Math.ceil(view.min / step) * step;
      ctx.font = '10px "SF Mono",Menlo,monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (var y = first; y <= view.max; y += step) {
        var x = y2x(y, w);
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.beginPath(); ctx.moveTo(x, ay); ctx.lineTo(x, ay + 5); ctx.stroke();
        ctx.fillStyle = 'rgba(190,200,215,0.65)';
        ctx.fillText(fmtYear(y), x, ay + 8);
      }

      // 当前年份指针
      var px = y2x(year, w);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,214,140,0.95)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, ROW_MAIN.y - 4); ctx.lineTo(px, ay + 4); ctx.stroke();
      // 手柄
      ctx.fillStyle = '#ffd68c';
      ctx.beginPath();
      ctx.moveTo(px, ROW_MAIN.y - 5);
      ctx.lineTo(px + 6, ROW_MAIN.y - 12);
      ctx.lineTo(px - 6, ROW_MAIN.y - 12);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    // ---------- 命中测试 ----------
    function hitPolity(mx, my) {
      var all = main.concat(minor);
      for (var i = 0; i < all.length; i++) {
        var d = all[i];
        if (d._bx0 === undefined) continue;
        if (mx >= d._bx0 && mx <= d._bx1 && my >= d._by - 1 && my <= d._by + d._bh + 1) return d;
      }
      return null;
    }

    // ---------- 交互 ----------
    function localPos(e) {
      var rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width, h: rect.height };
    }

    canvas.addEventListener('pointerdown', function (e) {
      var p = localPos(e);
      if (p.y >= axisTop(p.h)) {
        draggingAxis = true; dragStartX = p.x; dragStartMin = view.min;
      } else {
        draggingPointer = true;
        setYear(x2y(p.x, p.w), true);
      }
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', function (e) {
      var p = localPos(e);
      if (draggingAxis) {
        var span = view.max - view.min;
        var dy = (p.x - dragStartX) / plotW(p.w) * span;
        var nm = dragStartMin - dy;
        if (nm < MIN_Y) nm = MIN_Y;
        if (nm + span > MAX_Y) nm = MAX_Y - span;
        view.min = nm; view.max = nm + span;
        draw();
        return;
      }
      if (draggingPointer) { setYear(x2y(p.x, p.w), true); return; }
      var d = hitPolity(p.x, p.y);
      if (d !== hover) { hover = d; canvas.style.cursor = d ? 'pointer' : 'default'; draw(); }
      if (d) onHover(d, p);
      else onHover(null, p);
    });
    canvas.addEventListener('pointerup', function (e) {
      var p = localPos(e);
      if (draggingPointer) setYear(x2y(p.x, p.w), false);
      draggingPointer = false; draggingAxis = false;
    });
    canvas.addEventListener('pointerleave', function () {
      hover = null; draw(); onHover(null, null);
    });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = localPos(e);
      var anchor = x2y(p.x, p.w);
      var f = e.deltaY > 0 ? 1.25 : 0.8;
      var span = (view.max - view.min) * f;
      span = Math.max(60, Math.min(MAX_Y - MIN_Y, span));
      var ratio = (anchor - view.min) / (view.max - view.min);
      var nm = anchor - ratio * span;
      if (nm < MIN_Y) nm = MIN_Y;
      if (nm + span > MAX_Y) nm = MAX_Y - span;
      view.min = nm; view.max = nm + span;
      draw();
    }, { passive: false });

    function setYear(y, dragging) {
      y = Math.max(MIN_Y, Math.min(MAX_Y, Math.round(y)));
      if (y === year) return;              // 年份未变则完全不触发，避免与外层互相回调
      year = y;
      // 仅当「非拖动」（播放 / 点击胶囊 / 键盘）且年份滚出视野时才自动跟随；
      // 拖动时间轴指针时保持当前视野，不做任何自动缩放。
      if (!dragging && (y < view.min + (view.max - view.min) * 0.05 || y > view.min + (view.max - view.min) * 0.95)) {
        var span = view.max - view.min;
        view.min = Math.max(MIN_Y, y - span / 2);
        view.max = Math.min(MAX_Y, view.min + span);
      }
      draw();
      onChange(year, dragging);
    }

    self.setYear = function (y) { setYear(y, false); };
    self.getYear = function () { return year; };
    self.getView = function () { return { min: view.min, max: view.max }; };
    self.resetView = function () { view.min = MIN_Y; view.max = MAX_Y; draw(); };
    self.zoomTo = function (a, b) {
      view.min = Math.max(MIN_Y, a - 40); view.max = Math.min(MAX_Y, b + 40); draw();
    };
    self.render = draw;
    self.fmtYear = fmtYear;
    self.yearLabel = yearLabel;

    window.addEventListener('resize', draw);
    draw();
  }

  window.Timeline = Timeline;
  window.fmtYearCN = fmtYear;
})();
