/* =============================================================
 * Globe —— 球面历史疆域渲染
 * 采用「等距圆柱投影贴图的三维球体」方案：
 *   底图层（海洋 / 世界陆地 / 经纬网 / 省界）只绘制一次并缓存；
 *   疆域层按需重绘（仅在政权集合变化时），避免逐帧上传大纹理。
 * ============================================================= */
(function () {
  var TEX_W = 4096, TEX_H = 2048;
  var DEG = Math.PI / 180;

  // 经纬度 -> 单位球面坐标（与 SphereGeometry 默认 UV 映射一致）
  function llToVec3(lng, lat, r) {
    r = r === undefined ? 1 : r;
    var la = lat * DEG, lo = lng * DEG;
    return new THREE.Vector3(
      r * Math.cos(la) * Math.cos(lo),
      r * Math.sin(la),
      -r * Math.cos(la) * Math.sin(lo)
    );
  }

  function Globe(opts) {
    var container = opts.container;
    var self = this;

    // ---------- three.js 基础设施 ----------
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    // ---------- 贴图 canvas ----------
    var baseCanvas = document.createElement('canvas');
    baseCanvas.width = TEX_W; baseCanvas.height = TEX_H;
    var bctx = baseCanvas.getContext('2d');

    var texCanvas = document.createElement('canvas');
    texCanvas.width = TEX_W; texCanvas.height = TEX_H;
    var tctx = texCanvas.getContext('2d');

    var texture = new THREE.CanvasTexture(texCanvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    if ('colorSpace' in texture) texture.colorSpace = THREE.SRGBColorSpace;

    // ---------- 地球本体 ----------
    var earthMat = new THREE.MeshPhongMaterial({
      map: texture,
      shininess: 6,
      specular: new THREE.Color(0x101820),
      emissive: new THREE.Color(0x0a0f18),
      emissiveIntensity: 0.55
    });
    var earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), earthMat);
    scene.add(earth);

    // ---------- 大气辉光 ----------
    var atmMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0x4a86e8) } },
      vertexShader: [
        'varying vec3 vNormal;',
        'void main(){',
        '  vNormal = normalize(normalMatrix * normal);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor;',
        'varying vec3 vNormal;',
        'void main(){',
        '  float i = pow(max(0.0, 0.78 - dot(vNormal, vec3(0.0, 0.0, 1.0))), 2.6);',
        '  gl_FragColor = vec4(uColor, 1.0) * i * 0.85;',
        '}'
      ].join('\n'),
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false
    });
    var atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.21, 64, 48), atmMat);
    scene.add(atmosphere);

    // ---------- 灯光 ----------
    scene.add(new THREE.AmbientLight(0xffffff, 0.92));
    var headLight = new THREE.DirectionalLight(0xffffff, 0.55);
    scene.add(headLight);
    var rimLight = new THREE.DirectionalLight(0x6fa8ff, 0.22);
    scene.add(rimLight);

    // ---------- 星空 ----------
    (function () {
      var N = 1800, pos = new Float32Array(N * 3);
      for (var i = 0; i < N; i++) {
        var u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
        var r = 40 + Math.random() * 30;
        var s = Math.sqrt(1 - u * u);
        pos[i * 3] = r * s * Math.cos(a);
        pos[i * 3 + 1] = r * u;
        pos[i * 3 + 2] = r * s * Math.sin(a);
      }
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      var m = new THREE.PointsMaterial({ color: 0x9fb4d8, size: 0.28, sizeAttenuation: true, transparent: true, opacity: 0.75 });
      scene.add(new THREE.Points(g, m));
    })();

    // ---------- 视图状态 ----------
    var view = { lng: 105, lat: 22, dist: 3.0 };
    var target = { lng: 105, lat: 22, dist: 3.0 };
    var autoRotate = true;
    var showProvince = true, showGrid = true;
    var dragging = false, lastX = 0, lastY = 0, vLng = 0, vLat = 0;
    var lastInteract = 0;

    // ---------- 数据 ----------
    var GEO = window.GEO_BASE;
    var provByName = {};
    for (var i = 0; i < GEO.provinces.length; i++) provByName[GEO.provinces[i].n] = GEO.provinces[i];

    var dynProvCache = {};   // 省名 -> Path2D
    var dynPolyCache = {};   // 政权 id -> { paths: [ {path, level} ], key }
    var currentKey = '';
    var currentPolities = [];
    var baseKey = '';

    // ---------- 投影工具 ----------
    function px(lng) { return (lng + 180) / 360 * TEX_W; }
    function py(lat) { return (90 - lat) / 180 * TEX_H; }

    function pathFromRings(rings, ctx) {
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

      // 世界陆地（仅作球面背景，不含任何国界）
      var land = GEO.world;
      c.lineWidth = Math.max(1, TEX_W / 2200);
      c.strokeStyle = 'rgba(110,140,180,0.45)';
      c.fillStyle = '#16202f';
      for (var i = 0; i < land.length; i++) {
        var r = land[i];
        if (r.length < 3) continue;
        // 跳过南极洲（等距圆柱投影下会横跨整幅）
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
      texture.needsUpdate = true;
    }

    // ---------- 对外接口 ----------
    self.setPolities = function (polities) {
      currentPolities = polities;
      var key = '';
      for (var i = 0; i < polities.length; i++) key += polities[i].id + ',';
      if (key !== currentKey || baseKey !== (showGrid ? 'g' : '') + (showProvince ? 'p' : '')) {
        drawBase();
        // 底图重绘后必须整体重画
        currentKey = '';
      }
      if (key !== currentKey) {
        currentKey = key;
        drawTerritories(polities);
      }
    };

    self.setLayer = function (name, on) {
      if (name === 'province') showProvince = on; else if (name === 'grid') showGrid = on;
      drawBase();
      drawTerritories(currentPolities);
    };

    self.setAutoRotate = function (on) { autoRotate = on; };
    self.getAutoRotate = function () { return autoRotate; };

    self.focusChina = function () {
      target.lng = 105; target.lat = 22; target.dist = 2.75;
      vLng = vLat = 0;
      lastInteract = 0;
    };
    // 飞向指定经纬度（用于点击都城 / 政权后居中）
    self.flyTo = function (lng, lat, dist) {
      // 归一化到与当前视角最近的等价经度，避免绕远路
      var t = target.lng;
      while (lng - t > 180) lng -= 360;
      while (t - lng > 180) lng += 360;
      target.lng = lng;
      target.lat = Math.max(-80, Math.min(80, lat));
      if (dist) target.dist = Math.max(1.5, Math.min(5.5, dist));
      vLng = vLat = 0;
      lastInteract = performance.now();
    };
    self.zoom = function (f) {
      target.dist = Math.max(1.5, Math.min(5.5, target.dist * f));
      lastInteract = performance.now();
    };

    // 经纬度 -> 屏幕坐标（用于 HTML 标签叠加）
    var _v = new THREE.Vector3();
    self.project = function (lng, lat) {
      var p = llToVec3(lng, lat, 1);
      // 可见性：法线与视线夹角
      var toCam = new THREE.Vector3().copy(camera.position).sub(p).normalize();
      var facing = p.clone().normalize().dot(toCam);
      _v.copy(p).project(camera);
      var rect = renderer.domElement.getBoundingClientRect();
      return {
        x: (_v.x * 0.5 + 0.5) * rect.width,
        y: (-_v.y * 0.5 + 0.5) * rect.height,
        visible: facing > 0.12 && _v.z < 1
      };
    };

    // ---------- 交互 ----------
    var el = renderer.domElement;
    el.style.display = 'block';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.cursor = 'grab';
    el.style.touchAction = 'none';

    el.addEventListener('pointerdown', function (e) {
      dragging = true; el.style.cursor = 'grabbing';
      lastX = e.clientX; lastY = e.clientY; vLng = vLat = 0;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      var k = 0.18 * (target.dist / 3);
      target.lng -= dx * k;
      target.lat = Math.max(-85, Math.min(85, target.lat + dy * k));
      vLng = -dx * k; vLat = dy * k;
      lastInteract = performance.now();
    });
    el.addEventListener('pointerup', function (e) {
      dragging = false; el.style.cursor = 'grab';
      lastInteract = performance.now();
    });
    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      target.dist = Math.max(1.5, Math.min(5.5, target.dist * (1 + (e.deltaY > 0 ? 0.12 : -0.12))));
      lastInteract = performance.now();
    }, { passive: false });

    // ---------- 尺寸 ----------
    function resize() {
      var w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    }
    window.addEventListener('resize', resize);

    // ---------- 主循环 ----------
    function tick() {
      requestAnimationFrame(tick);
      resize();

      // 惯性 + 自动自转
      if (!dragging) {
        target.lng += vLng * 0.92;
        target.lat = Math.max(-85, Math.min(85, target.lat + vLat * 0.92));
        vLng *= 0.90; vLat *= 0.90;
        if (Math.abs(vLng) < 0.002) vLng = 0;
        if (Math.abs(vLat) < 0.002) vLat = 0;
        if (autoRotate && !vLng && !vLat && performance.now() - lastInteract > 1500) {
          target.lng += 0.055;
        }
      }
      // 平滑跟随
      view.lng += (target.lng - view.lng) * 0.16;
      view.lat += (target.lat - view.lat) * 0.16;
      view.dist += (target.dist - view.dist) * 0.14;

      var p = llToVec3(view.lng, view.lat, view.dist);
      camera.position.copy(p);
      camera.lookAt(0, 0, 0);

      headLight.position.copy(camera.position);
      rimLight.position.set(-camera.position.z, camera.position.y * 0.4, camera.position.x);

      renderer.render(scene, camera);
      if (opts.onFrame) opts.onFrame();
    }

    drawBase();
    resize();
    tick();
    self.container = container;
  }

  window.Globe = Globe;
  window.llToVec3 = llToVec3;
})();
