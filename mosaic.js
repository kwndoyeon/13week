/* ============================================================
 *  모자이크 그래픽 (점 격자 지도)
 *   - 지역의 모양대로 격자를 깔고, 칸마다 그 위치의 인구밀도에 맞는 글리프를 그린다.
 *   - 인구가 많을수록 격자가 잘게 쪼개지고(칸 수↑), 적을수록 성기다.
 *   - 빈 칸 없이 7가지 글리프로 채워서, 밀도가 낮아도 허전해 보이지 않게 한다.
 * ============================================================ */
const Mosaic = (() => {
  const CELL_MAX = 22, CELL_MIN = 7;        // 칸 크기(px): 인구 적음 → 많음
  const PAD = 10;

  /* ---------- 글리프 스프라이트 (칸 크기·종류별로 한 번만 그려 캐시) ---------- */
  const spriteCache = new Map();
  // cls 0 빈 사각 / 1 회색 사각(빗금) / 2 링 / 3 링+점 / 4 짙은 링+회색 / 5 검은 점 / 6 검은 테두리 + 점(핫스팟)
  const NCLS = 7;
  /* 색 조합: base = 호버 창 · map = 전체 지도(조금 더 진하게) · accent = 호버한 지역(붉은색) */
  const TONES = {
    base:   { e: '#cfcfcf', eF: '#efefef', g: '#d6d6d6', gV: '#f1f1f1', hat: '#b8b8b8', r2: '#8e8e8e', d2: '#a2a2a2', r3: '#5f5f5f', d4: '#8a8a8a', r4: '#2f2f2f', d5: '#1d1d1d', k: '#111' },
    map:    { e: '#b4b4b4', eF: '#dedede', g: '#c6c6c6', gV: '#e4e4e4', hat: '#a2a2a2', r2: '#7f7f7f', d2: '#959595', r3: '#555',    d4: '#7d7d7d', r4: '#2a2a2a', d5: '#1a1a1a', k: '#0e0e0e' },
    accent: { e: '#f0b9c6', eF: '#fbe1e7', g: '#f5c3cf', gV: '#fbe6eb', hat: '#ef9cb0', r2: '#ec7591', d2: '#f08ea5', r3: '#e44a6e', d4: '#ef7f99', r4: '#d61f4a', d5: '#e0244f', k: '#b8103a' },
  };
  function sprite(cls, variant, size, dpr, tone = 'base') {
    const key = `${cls}|${variant}|${size}|${dpr}|${tone}`;
    let c = spriteCache.get(key);
    if (c) return c;
    const T = TONES[tone] || TONES.base;
    c = document.createElement('canvas');
    c.width = c.height = Math.max(1, Math.round(size * dpr));
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const s = size, m = s / 2, r = s * 0.36;
    g.lineWidth = Math.max(1, s * 0.08);
    const ring = (col, rr = r) => { g.strokeStyle = col; g.beginPath(); g.arc(m, m, rr, 0, 6.2832); g.stroke(); };
    const dot = (col, rr) => { g.fillStyle = col; g.beginPath(); g.arc(m, m, rr, 0, 6.2832); g.fill(); };
    const inset = s < 7 ? 0.5 : 1;
    switch (cls) {
      case 0:
        if (variant) { g.fillStyle = T.eF; g.fillRect(inset, inset, s - 2 * inset, s - 2 * inset); }
        else { g.strokeStyle = T.e; g.lineWidth = 1; g.strokeRect(inset + 0.5, inset + 0.5, s - 2 * inset - 1, s - 2 * inset - 1); }
        break;
      case 1:
        g.fillStyle = variant ? T.gV : T.g; g.fillRect(inset, inset, s - 2 * inset, s - 2 * inset);
        if (variant) {                                           // 빗금 칸
          g.save(); g.beginPath(); g.rect(inset, inset, s - 2 * inset, s - 2 * inset); g.clip();
          g.strokeStyle = T.hat; g.lineWidth = 1;
          for (let k = -s; k < s * 2; k += Math.max(3, s * 0.28)) { g.beginPath(); g.moveTo(k, s); g.lineTo(k + s, 0); g.stroke(); }
          g.restore();
        }
        break;
      case 2:
        ring(T.r2);
        if (variant) dot(T.d2, r * 0.4);
        break;
      case 3: ring(T.r3); dot(T.r3, r * 0.42); break;
      case 4: dot(T.d4, r); ring(T.r4); break;
      case 5: dot(T.d5, r * 1.02); break;
      default:
        g.strokeStyle = T.k; g.lineWidth = Math.max(1.2, s * 0.11); g.strokeRect(inset + 0.5, inset + 0.5, s - 2 * inset - 1, s - 2 * inset - 1);
        dot(T.k, r * 0.62);
    }
    spriteCache.set(key, c);
    return c;
  }

  /* ---------- 해시 · 값 노이즈 (칸마다 자연스러운 편차) ---------- */
  function hash2(i, j, seed) {
    let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 2147483647)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  /* ---------- 점-다각형 판정 ---------- */
  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const inPoly = (x, y, rings) => inRing(x, y, rings[0]) && !rings.slice(1).some(h => inRing(x, y, h));

  /**
   * 지역 준비: 지역에 속한 행정동들을 캔버스 크기에 맞춰 투영하고 격자 캐시를 만든다.
   * dongs: [{idx, geometry}]
   */
  function prepare(dongs, W, H) {
    const fc = { type: 'FeatureCollection', features: dongs.map(d => ({ type: 'Feature', geometry: d.geometry, properties: {} })) };
    const proj = d3.geoMercator().fitExtent([[PAD, PAD], [W - PAD, H - PAD]], fc);
    const items = dongs.map(d => {
      const polys = (d.geometry.type === 'Polygon' ? [d.geometry.coordinates] : d.geometry.coordinates)
        .map(poly => poly.map(ring => ring.map(p => proj(p))));
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      polys.forEach(poly => poly[0].forEach(([x, y]) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }));
      return { idx: d.idx, polys, bbox: [x0, y0, x1, y1] };
    });
    return { W, H, items, grids: new Map() };
  }

  function locate(prep, x, y) {
    for (const it of prep.items) {
      const b = it.bbox;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      for (const poly of it.polys) if (inPoly(x, y, poly)) return it.idx;
    }
    return -1;
  }

  function grid(prep, cell) {
    let g = prep.grids.get(cell);
    if (g) return g;
    const cols = Math.floor(prep.W / cell), rows = Math.floor(prep.H / cell);
    const x0 = (prep.W - cols * cell) / 2, y0 = (prep.H - rows * cell) / 2;
    const ids = new Int16Array(cols * rows);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) ids[j * cols + i] = locate(prep, x0 + (i + 0.5) * cell, y0 + (j + 0.5) * cell);
    g = { cols, rows, x0, y0, ids };
    prep.grids.set(cell, g);
    return g;
  }

  /** 밀도 + 위치 노이즈 → 글리프 단계(0~6). 칸 크기가 바뀌어도 같은 자리는 비슷한 값 */
  function classify(dens, px, py, th, seed) {
    const n = 0.72 * vnoise(px / 64, py / 64, seed) + 0.28 * hash2(Math.floor(px / 4), Math.floor(py / 4), seed + 7);
    const v = dens * (0.35 + 1.3 * n);
    let cls = 0;
    while (cls < NCLS - 1 && v >= th[cls]) cls++;
    return cls;
  }

  /** 인구 규모 u(0~1) → 칸 크기. 인구가 많을수록 작은 칸(= 더 촘촘한 격자) */
  const cellSizeFor = u => Math.round(CELL_MAX - (CELL_MAX - CELL_MIN) * Math.min(1, Math.max(0, u)));

  /**
   * 그리기
   *  opt.u          0~1 지역의 상대 인구 규모
   *  opt.density    (dongIdx) => 명/km²
   *  opt.thresholds 길이 6 (오름차순) → 글리프 7단계 경계
   *  opt.seed       지역별 고정 노이즈 시드
   */
  function render(canvas, prep, opt) {
    const dpr = window.devicePixelRatio || 1;
    const W = prep.W, H = prep.H;
    if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (opt.bg) { ctx.fillStyle = opt.bg; ctx.fillRect(0, 0, W, H); }   // 기본은 투명 (뒤가 비치게)

    const cell = cellSizeFor(opt.u);
    const g = grid(prep, cell);
    const th = opt.thresholds;
    const densCache = new Map();
    let drawn = 0;
    for (let j = 0; j < g.rows; j++) {
      for (let i = 0; i < g.cols; i++) {
        const id = g.ids[j * g.cols + i];
        if (id < 0) continue;
        let dens = densCache.get(id);
        if (dens === undefined) { dens = opt.density(id); densCache.set(id, dens); }
        const px = g.x0 + i * cell, py = g.y0 + j * cell;
        const cls = classify(dens, px, py, th, opt.seed);
        const variant = hash2(i, j, opt.seed + 3) < 0.45 ? 1 : 0;
        ctx.drawImage(sprite(cls, variant, cell, dpr), px, py, cell, cell);
        drawn++;
      }
    }
    return { cell, cols: g.cols, rows: g.rows, drawn };
  }

  /** 범례용: 글리프 7개를 작은 캔버스로 */
  function legendGlyph(cls, size = 16) {
    const c = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    c.width = c.height = size * dpr; c.style.width = c.style.height = size + 'px';
    c.getContext('2d').drawImage(sprite(cls, 0, size, dpr), 0, 0);
    return c;
  }

  return { prepare, render, cellSizeFor, legendGlyph, sprite, classify, hash2, NCLS, CELL_MAX, CELL_MIN };
})();
