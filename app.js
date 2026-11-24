/* ============================================================
 *  Seoul O'Clock — 메인
 *   지도(SVG + d3.zoom) · 시간 슬라이더 · 호버 세부정보 · 모자이크 그래픽
 *
 *  지역 단계(확대 배율에 따라 자동 전환)
 *    level 0 : 9개 권역       (k <  CONFIG.levels.gu)
 *    level 1 : 25개 자치구    (k <  CONFIG.levels.dong)
 *    level 2 : 약 425개 행정동
 * ============================================================ */
(() => {
  'use strict';
  const CFG = window.CONFIG;
  const $ = s => document.querySelector(s);
  const R_EARTH = 6371.0088;                      // km
  const DIM = '#c4c4c4';

  const state = { hour: 12, level: 0, hover: null, src: null, k: 1, playing: false, timer: null };

  /* 데이터 */
  let D = [];                       // 행정동 [{idx, geometry, gu, guIdx, dong, zone, area, keys, bounds, pc}]
  let GU = [];                      // 자치구 [{name, zone, dongs:[]}]
  const regions = [new Map(), new Map(), new Map()];   // level → key → region
  const series = new Map();         // regionKey → Float32Array(24)
  const peerMax = [0, 0, 0], peerMin = [0, 0, 0];
  let dongPop = null;               // Float32Array(n*24)
  let thresholds = [];              // 밀도 글리프 경계(명/km²)
  let dataInfo = { mode: 'demo', note: '' };

  /* 지도 */
  let svg, gRoot, proj, path, zoom, W = 0, H = 0, edges = [], meshOK = true;
  let dongSel, gShade, shadeSel, dimPath, hoverLine, labelsZ, labelsG, labelsD;
  let basemapInfo = { kind: 'none', label: '' };
  const pathCache = new Map();      // 'dim|key' · 'out|key' → path 문자열
  const MM = { canvas: null, ctx: null, id: null, idCtx: null, paths: [], raf: 0 };   // 전체 지도 모자이크
  const mz = { prepCache: new Map() };

  /* ============================================================
   *  1. GeoJSON 불러오기 · 정리
   * ============================================================ */
  async function loadGeo() {
    const errs = [];
    for (const url of CFG.geoUrls) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) { errs.push(`${url}: ${e.message}`); }
    }
    throw new Error('행정동 경계 GeoJSON 을 불러오지 못했습니다.\n' + errs.join('\n'));
  }

  /* d3 는 "바깥 고리 = 시계 방향" 규칙을 쓴다. GeoJSON 파일마다 방향이 제각각이라 불러올 때 맞춰 둔다. */
  const ringArea = r => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return a / 2; };
  function rewind(geom) {
    const fix = poly => poly.map((ring, i) => {
      const cw = ringArea(ring) < 0 ? false : true;        // shoelace>0 ⇒ (경도,위도) 평면에서 시계 방향
      const wantCW = i === 0;
      return cw === wantCW ? ring : ring.slice().reverse();
    });
    if (geom.type === 'Polygon') geom.coordinates = fix(geom.coordinates);
    else if (geom.type === 'MultiPolygon') geom.coordinates = geom.coordinates.map(fix);
  }

  function normalize(geo) {
    const guIndex = new Map();
    for (const f of geo.features) {
      const p = f.properties || {};
      const nm = String(p.adm_nm || p.ADM_NM || '');
      const parts = nm.split(/\s+/);
      if (nm && !/^서울/.test(nm)) continue;
      const gu = parts.length >= 3 ? parts[1] : (p.sggnm || '');
      const zone = ZONE_OF_GU[gu];
      if (!zone) continue;
      const dong = parts.length >= 3 ? parts.slice(2).join(' ') : (parts[parts.length - 1] || '');
      rewind(f.geometry);
      let gi = guIndex.get(gu);
      if (gi === undefined) { gi = GU.length; guIndex.set(gu, gi); GU.push({ name: gu, zone, dongs: [] }); }
      const a2 = String(p.adm_cd2 || ''), a1 = String(p.adm_cd || '');
      const d = {
        idx: D.length, geometry: f.geometry, gu, guIdx: gi, dong, zone, feature: f,
        area: d3.geoArea(f) * R_EARTH * R_EARTH,
        keys: { adm2_8: a2.slice(0, 8), adm2_10: a2, adm_8: a1.slice(0, 8), adm_7: a1.slice(0, 7) },
      };
      D.push(d); GU[gi].dongs.push(d.idx);
    }
    if (!D.length) throw new Error('서울 행정동 feature 를 찾지 못했습니다 (properties.adm_nm 형식 확인).');
  }

  /* 같은 변을 공유하는 행정동끼리 짝지어 권역/구 경계선 추출 (topojson 없이) */
  function buildEdges() {
    const Q = 1e5, map = new Map();
    D.forEach(d => {
      const polys = d.geometry.type === 'Polygon' ? [d.geometry.coordinates] : d.geometry.coordinates;
      polys.forEach(poly => poly.forEach(ring => {
        for (let j = 0; j < ring.length - 1; j++) {
          const p = ring[j], q = ring[j + 1];
          const kp = Math.round(p[0] * Q) + ',' + Math.round(p[1] * Q), kq = Math.round(q[0] * Q) + ',' + Math.round(q[1] * Q);
          if (kp === kq) continue;
          const key = kp < kq ? kp + '|' + kq : kq + '|' + kp;
          const e = map.get(key);
          if (!e) map.set(key, { p, q, a: d.idx, b: -1 });
          else if (e.b < 0 && e.a !== d.idx) e.b = d.idx;
        }
      }));
    });
    edges = [...map.values()];
    const outer = edges.filter(e => e.b < 0).length;
    meshOK = outer / edges.length < 0.3;            // 경계가 어긋난 데이터면 구/권역 경계선을 포기
    if (!meshOK) console.warn('[Seoul O’Clock] 행정동 경계가 서로 맞물리지 않아 권역·구 경계선을 생략합니다.');
  }

  /* ============================================================
   *  2. 지역(권역/구/동) 구성
   * ============================================================ */
  function buildRegions() {
    ZONES.forEach(z => regions[0].set('z' + z.id, {
      key: 'z' + z.id, level: 0, num: z.id, name: z.name, sub: z.short, zone: z, dongs: [],
    }));
    GU.forEach((g, i) => regions[1].set('g' + i, {
      key: 'g' + i, level: 1, num: g.zone.id, name: g.name, sub: g.zone.name, zone: g.zone, dongs: g.dongs.slice(),
    }));
    D.forEach(d => {
      regions[0].get('z' + d.zone.id).dongs.push(d.idx);
      regions[2].set('d' + d.idx, {
        key: 'd' + d.idx, level: 2, num: d.zone.id, name: d.dong, sub: d.gu + ' · ' + d.zone.name, zone: d.zone, dongs: [d.idx],
      });
    });
    regions.forEach(m => m.forEach(r => { r.set = new Set(r.dongs); r.area = r.dongs.reduce((s, i) => s + D[i].area, 0); }));
  }
  const regionOf = (level, d) => regions[level].get(level === 0 ? 'z' + d.zone.id : level === 1 ? 'g' + d.guIdx : 'd' + d.idx);

  /* ============================================================
   *  3. 인구 데이터 (실데이터 → 행정동 매칭 / 데모)
   * ============================================================ */
  function matchLive(byCode) {
    const codes = [...byCode.keys()];
    const lookup = (m, c) => m.get(c) || m.get(c.slice(0, 8)) || m.get(c.slice(0, 7));
    let best = null;
    for (const scheme of ['adm2_8', 'adm2_10', 'adm_8', 'adm_7']) {
      const m = new Map();
      D.forEach(d => { if (d.keys[scheme]) m.set(d.keys[scheme], d); });
      let hit = 0;
      codes.forEach(c => { if (lookup(m, c)) hit++; });
      if (!best || hit > best.hit) best = { scheme, m, hit };
    }
    if (best.hit < D.length * 0.3) throw new Error(`행정동 코드 매칭 실패 (${best.hit}/${D.length}). GeoJSON 의 adm_cd/adm_cd2 와 API 코드 체계를 확인하세요.`);

    const pop = new Float32Array(D.length * 24), matched = new Uint8Array(D.length);
    byCode.forEach((arr, c) => {
      const d = lookup(best.m, c);
      if (d) { pop.set(arr, d.idx * 24); matched[d.idx] = 1; }
    });
    // 코드가 안 맞는 동(신설 동 등)은 같은 구의 평균 밀도 × 면적으로 추정
    for (let h = 0; h < 24; h++) {
      GU.forEach(g => {
        let p = 0, a = 0;
        g.dongs.forEach(i => { if (matched[i]) { p += pop[i * 24 + h]; a += D[i].area; } });
        const dens = a ? p / a : 0;
        g.dongs.forEach(i => { if (!matched[i]) pop[i * 24 + h] = dens * D[i].area; });
      });
    }
    return { pop, hit: best.hit, scheme: best.scheme };
  }

  async function loadPopulation() {
    const url = new URLSearchParams(location.search);
    if (!CFG.forceDemo && !url.has('demo')) {
      try {
        const live = await PopData.loadLive(CFG, msg => { $('#loading').textContent = msg; });
        const m = matchLive(live.byCode);
        dataInfo = { mode: 'live', note: `서울 생활인구(내국인) ${live.date.replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3')} · 행정동 ${m.hit}/${D.length} 매칭` };
        return m.pop;
      } catch (e) {
        console.warn('[Seoul O’Clock] 실데이터 로드 실패 → 데모 데이터 사용:', e.message, e.all || '');
        dataInfo = { mode: 'demo', note: e.code === 'NO_KEY' ? 'API 키 없음' : '실데이터 로드 실패: ' + e.message.slice(0, 120) };
      }
    } else dataInfo = { mode: 'demo', note: '데모 모드' };
    return PopData.makeDemo(D);
  }

  function aggregate() {
    series.clear();
    regions.forEach(m => m.forEach(r => {
      const s = new Float32Array(24);
      r.dongs.forEach(i => { for (let h = 0; h < 24; h++) s[h] += dongPop[i * 24 + h]; });
      series.set(r.key, s);
    }));
    regions.forEach((m, lv) => {
      peerMax[lv] = 0; peerMin[lv] = Infinity;
      m.forEach(r => { const s = series.get(r.key); peerMax[lv] = Math.max(peerMax[lv], ...s); peerMin[lv] = Math.min(peerMin[lv], ...s); });
    });

    // 밀도 글리프 경계: 하루 전체 행정동 밀도 분포의 분위수
    const dens = [];
    D.forEach(d => { for (let h = 0; h < 24; h++) dens.push(dongPop[d.idx * 24 + h] / d.area); });
    dens.sort((a, b) => a - b);
    const q = p => dens[Math.min(dens.length - 1, Math.floor(p * dens.length))];
    thresholds = [0.12, 0.3, 0.5, 0.7, 0.87, 0.975].map(q);
  }

  const popOf = (r, h = state.hour) => series.get(r.key)[h];
  const fmt = n => Math.round(n).toLocaleString('ko-KR');
  const hh = h => String(h).padStart(2, '0') + ':00';

  /* ============================================================
   *  4. 지도 그리기
   * ============================================================ */
  function initSvg() {
    svg = d3.select('#map');
    gRoot = svg.append('g');
    gShade = gRoot.append('g').attr('class', 'shade');            // 지역별 인구 음영 (지역 하나 = path 하나 → 이음매 없음)
    dimPath = gRoot.append('path').attr('class', 'dimmer');        // 호버 시 나머지 지역을 덮는 한 장
    gRoot.append('path').attr('class', 'mesh mesh-gu');
    gRoot.append('path').attr('class', 'mesh mesh-zone');
    gRoot.append('path').attr('class', 'mesh mesh-outer');
    hoverLine = gRoot.append('path').attr('class', 'hover-outline');
    const gDong = gRoot.append('g');                               // 투명한 마우스 판정용
    dongSel = gDong.selectAll('path').data(D).join('path').attr('class', 'dong')
      .on('pointerenter', (e, d) => { trackPtr(e); if (e.buttons === 0) requestHover(regionOf(state.level, d)); })
      .on('pointerleave', e => { trackPtr(e); requestHover(null); })
      .on('click', (e, d) => { zoomToRegion(regionOf(state.level, d)); })
      .on('dblclick', (e, d) => { location.href = 'detail.html?zone=' + d.zone.id; });
    const gl = gRoot.append('g');
    labelsZ = gl.selectAll('.lab-z').data([]).join('text');      // 지도 위 권역 번호(1~9)는 표시하지 않음
    labelsG = gl.selectAll('.lab-g').data([...regions[1].values()]).join('text').attr('class', 'lab lab-g').text(r => r.name);
    labelsD = gl.selectAll('.lab-d').data([...regions[2].values()]).join('text').attr('class', 'lab lab-d').text(r => r.name);

    zoom = d3.zoom().scaleExtent([1, 80]).on('zoom', e => onZoom(e.transform));
    svg.call(zoom).on('dblclick.zoom', null);
    svg.on('pointermove', trackPtr);
  }
  let lastPtr = null, curT = d3.zoomIdentity;

  function layout() {
    const r = $('#stage').getBoundingClientRect();
    W = r.width; H = r.height;
    svg.attr('viewBox', `0 0 ${W} ${H}`);
    const fc = { type: 'FeatureCollection', features: D.map(d => d.feature) };
    const pad = Math.min(W, H) * 0.06;
    proj = d3.geoMercator().fitExtent([[pad, pad], [W - pad * 1.2, H - pad]], fc);
    path = d3.geoPath(proj).digits(3);      // 80배 확대해도 배경 지도와 어긋나지 않게 소수 셋째 자리까지

    D.forEach(d => { d.dstr = path(d.feature); });
    MM.paths = D.map(d => new Path2D(d.dstr));
    dongSel.attr('d', d => d.dstr);
    regions.forEach(m => m.forEach(r => { r.dstr = null; }));
    pathCache.clear();
    D.forEach(d => { d.bounds = path.bounds(d.feature); d.pc = path.centroid(d.feature); d.parea = path.area(d.feature); });
    zoom.extent([[0, 0], [W, H]]).translateExtent([[-W * 0.15, -H * 0.15], [W * 1.15, H * 1.15]]);

    // 경계 메시
    if (meshOK) {
      const outer = [], zone = [], gu = [];
      edges.forEach(e => {
        if (e.b < 0) outer.push(e);
        else if (D[e.a].zone !== D[e.b].zone) zone.push(e);
        else if (D[e.a].guIdx !== D[e.b].guIdx) gu.push(e);
      });
      meshLists = { outer, zone, gu };
      meshCache.clear();
      setMesh(null);
    } else svg.selectAll('.mesh').attr('d', null);

    // 라벨 위치: 지역 중심에 가장 가까운 행정동 중심점(오목한 지역에서도 지역 안에 놓이도록)
    regions.forEach(m => m.forEach(rg => {
      let sx = 0, sy = 0, sa = 0;
      rg.dongs.forEach(i => { const d = D[i]; sx += d.pc[0] * d.parea; sy += d.pc[1] * d.parea; sa += d.parea; });
      const cx = sx / sa, cy = sy / sa;
      let bd = Infinity, bp = [cx, cy], x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      rg.dongs.forEach(i => {
        const d = D[i], dd = (d.pc[0] - cx) ** 2 + (d.pc[1] - cy) ** 2;
        if (dd < bd) { bd = dd; bp = d.pc; }
        x0 = Math.min(x0, d.bounds[0][0]); y0 = Math.min(y0, d.bounds[0][1]); x1 = Math.max(x1, d.bounds[1][0]); y1 = Math.max(y1, d.bounds[1][1]);
      });
      rg.pc = bp; rg.bounds = [[x0, y0], [x1, y1]];
    }));
    [labelsZ, labelsG, labelsD].forEach(s => s.attr('x', r => r.pc[0]).attr('y', r => r.pc[1]));
    mz.prepCache.clear();
    buildShade();
    updateLabelVisibility();
    applyFills();
    Basemap.sync(proj, curT, W, H);
    scheduleMapMosaic();
  }

  /* ============================================================
   *  4-1. 전체 지도 모자이크
   *   - 화면 크기 고정 칸(px)의 격자를 지도에 붙여서(이동해도 칸이 따라감) 깐다.
   *   - 현재 단계(권역/구/동)의 지역마다 인구 규모에 따라 칸 크기가 다르다 → 많을수록 촘촘.
   *   - 칸마다 그 자리 행정동의 밀도(현재 시간)로 글리프 7단계.
   *   - 칸이 어느 행정동인지는 "ID 지도"(동마다 고유색으로 칠한 숨은 캔버스)에서 읽는다.
   * ============================================================ */
  const ID_SCALE = 0.5;
  const idColor = i => `rgb(${i & 255},${(i >> 8) & 255},${(i * 37 + 11) & 255})`;
  function scheduleMapMosaic() {
    if (!CFG.mapMosaic || MM.raf) return;
    MM.raf = requestAnimationFrame(() => { MM.raf = 0; drawMapMosaic(); });
  }
  function drawMapMosaic() {
    if (!MM.canvas || !MM.paths.length || !W) return;
    const t = curT, dpr = window.devicePixelRatio || 1;
    if (MM.canvas.width !== Math.round(W * dpr) || MM.canvas.height !== Math.round(H * dpr)) {
      MM.canvas.width = Math.round(W * dpr); MM.canvas.height = Math.round(H * dpr);
    }
    // ① ID 지도
    const iw = Math.ceil(W * ID_SCALE), ih = Math.ceil(H * ID_SCALE);
    if (MM.id.width !== iw || MM.id.height !== ih) { MM.id.width = iw; MM.id.height = ih; }
    const ic = MM.idCtx;
    ic.setTransform(1, 0, 0, 1, 0, 0); ic.clearRect(0, 0, iw, ih);
    ic.setTransform(ID_SCALE * t.k, 0, 0, ID_SCALE * t.k, ID_SCALE * t.x, ID_SCALE * t.y);
    D.forEach(d => { ic.fillStyle = idColor(d.idx); ic.fill(MM.paths[d.idx]); });
    const px = ic.getImageData(0, 0, iw, ih).data;
    const lookup = (x, y) => {
      const qx = Math.floor(x * ID_SCALE), qy = Math.floor(y * ID_SCALE);
      if (qx < 0 || qy < 0 || qx >= iw || qy >= ih) return -1;
      const o = (qy * iw + qx) * 4;
      if (px[o + 3] !== 255) return -1;                       // 경계 안티앨리어싱(반투명) → 버림
      const id = px[o] | (px[o + 1] << 8);
      return id < D.length && px[o + 2] === ((id * 37 + 11) & 255) ? id : -1;   // 두 동 색이 섞인 픽셀 → 버림
    };

    // ② 지역별 칸 크기 (현재 단계, 현재 시간)
    const lv = state.level, h = state.hour, hi = peerMax[lv], lo = peerMin[lv];
    const mc = Array.isArray(CFG.mapCell) ? CFG.mapCell[lv] : CFG.mapCell;     // 단계별 칸 크기
    const CMAX = mc.max, CMIN = mc.min;
    const hov = state.hover ? state.hover.set : null;
    const cellOf = new Map(), sizes = new Set();
    regions[lv].forEach(r => {
      const u = Math.min(1, Math.max(0, (popOf(r, h) - lo) / ((hi - lo) || 1))) ** 0.6;
      const c = Math.round(CMAX - (CMAX - CMIN) * u);
      cellOf.set(r.key, c); sizes.add(c);
    });
    const dens = new Float32Array(D.length);
    D.forEach(d => { dens[d.idx] = dongPop[d.idx * 24 + h] / d.area; });
    const regKey = D.map(d => regionOf(lv, d).key);

    // ③ 그리기
    const ctx = MM.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    sizes.forEach(c => {
      const ox = ((t.x % c) + c) % c, oy = ((t.y % c) + c) % c;     // 격자를 지도에 고정
      const gx0 = Math.round((ox - t.x) / c), gy0 = Math.round((oy - t.y) / c);
      for (let j = -1, y = oy - c; y < H; j++, y += c) {
        for (let i = -1, x = ox - c; x < W; i++, x += c) {
          const id = lookup(x + c / 2, y + c / 2);
          if (id < 0 || cellOf.get(regKey[id]) !== c) continue;
          const gx = gx0 + i, gy = gy0 + j;                           // 지도 기준 칸 번호 (이동해도 그대로)
          const cls = Mosaic.classify(dens[id], gx * 9, gy * 9, thresholds, 1234);
          const variant = Mosaic.hash2(gx, gy, 1237) < 0.45 ? 1 : 0;
          ctx.drawImage(Mosaic.sprite(cls, variant, c, dpr, hov && hov.has(id) ? 'accent' : 'map'), x, y, c, c);
        }
      }
    });
  }

  const seg = list => list.map(e => {
    const a = proj(e.p), b = proj(e.q);
    return `M${a[0].toFixed(2)},${a[1].toFixed(2)}L${b[0].toFixed(2)},${b[1].toFixed(2)}`;
  }).join('');
  /* 경계선. 호버 중이면 그 지역에 닿는 선은 빼고 그린다 */
  let meshLists = null;
  const meshCache = new Map();
  function setMesh(reg) {
    if (!meshLists) return;
    const key = reg ? reg.key : '-';
    let m = meshCache.get(key);
    if (!m) {
      const keep = reg ? (e => !reg.set.has(e.a) && !(e.b >= 0 && reg.set.has(e.b))) : null;
      m = {};
      for (const k of ['outer', 'zone', 'gu']) m[k] = seg(keep ? meshLists[k].filter(keep) : meshLists[k]);
      meshCache.set(key, m);
      if (meshCache.size > 30) meshCache.delete([...meshCache.keys()][1]);
    }
    svg.select('.mesh-outer').attr('d', m.outer);
    svg.select('.mesh-zone').attr('d', m.zone);
    svg.select('.mesh-gu').attr('d', m.gu);
  }
  const regionPath = r => r.dstr || (r.dstr = r.dongs.map(i => D[i].dstr).join(''));

  /* 현재 단계의 지역마다 path 하나 */
  function buildShade() {
    shadeSel = gShade.selectAll('path').data([...regions[state.level].values()], r => r.key)
      .join('path').attr('d', regionPath);
  }

  function onZoom(t) {
    curT = t; state.k = t.k;
    gRoot.attr('transform', t);
    Basemap.sync(proj, t, W, H);
    scheduleMapMosaic();
    svg.style('--k', t.k);
    const lv = t.k >= CFG.levels.dong ? 2 : t.k >= CFG.levels.gu ? 1 : 0;
    if (lv !== state.level) {
      state.level = lv;
      svg.classed('lvl0', lv === 0).classed('lvl1', lv === 1).classed('lvl2', lv === 2);
      setHover(null);
      buildShade();
      scheduleMapMosaic();
      applyFills();
      requestAnimationFrame(rehoverAtPointer);
    }
    if (lv === 2) updateLabelVisibility();
    clearTimeout(rehoverT); rehoverT = setTimeout(rehoverAtPointer, 90);
    d3.select('#zoomhint').style('opacity', t.k > 1.05 ? 0 : 1);
  }

  /* 동 라벨은 화면에서 충분히 클 때만 */
  function updateLabelVisibility() {
    if (!labelsD) return;
    const k = state.k;
    labelsD.classed('off', r => { const d = D[r.dongs[0]]; return (d.bounds[1][0] - d.bounds[0][0]) * k < 46; });
  }

  /* 확대·축소로 지도만 움직이면 마우스는 가만히 있어도 아래 지역이 바뀐다 → 포인터 아래를 다시 확인 */
  let rehoverT = 0;
  /* 호버 의도 지연: 모자이크 창으로 마우스를 옮기는 동안 지나가는 다른 지역 때문에 창이 바뀌지 않도록
   *  (창이 떠 있을 때만 0.2초 기다렸다 바꿈. 창 안에 들어가면 고정) */
  let intentT = 0;
  const mzLock = { on: false, drag: false };
  const ptrHist = [];               // 최근 마우스 위치 (움직이는 방향 계산용)
  function trackPtr(e) {
    lastPtr = [e.clientX, e.clientY];
    const l = ptrHist[ptrHist.length - 1];
    if (l && l.x === e.clientX && l.y === e.clientY) return;
    ptrHist.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (ptrHist.length > 12) ptrHist.shift();
  }
  /* 마우스가 지금 모자이크 창 쪽으로 움직이고 있나? (최근 ~120ms 이동 방향의 직선이 창을 지나가는지) */
  function headingToWindow() {
    const win = $('#mosaic');
    if (!state.hover || win.classList.contains('hidden') || ptrHist.length < 2) return false;
    const tgt = $('#vslider');                                        // 목표 = 창 안의 세로 슬라이더
    const now = performance.now(), p1 = ptrHist[ptrHist.length - 1];
    let p0 = ptrHist.find(p => now - p.t < 120);
    if (!p0 || p0 === p1) p0 = ptrHist[ptrHist.length - 2];          // 멈춰 있다가 막 움직인 경우: 직전 위치 기준
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    if (Math.hypot(dx, dy) < 3) return false;
    const r = tgt.getBoundingClientRect(), pad = 16;
    let t0 = 0, t1 = Infinity;                                       // 직선-사각형 교차 (slab)
    for (const [o, d, lo, hi] of [[p1.x, dx, r.left - pad, r.right + pad], [p1.y, dy, r.top - pad, r.bottom + pad]]) {
      if (Math.abs(d) < 1e-6) { if (o < lo || o > hi) return false; continue; }
      let a = (lo - o) / d, b = (hi - o) / d; if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if (t0 > t1) return false;
    }
    return true;
  }
  function requestHover(reg) {
    if (mzLock.on) return;
    clearTimeout(intentT);
    if (reg === state.hover && state.src === 'map') return;
    // 창 쪽으로 가는 중일 때만 잠깐 기다림, 그 외에는 즉시 바꿈
    if (state.hover && state.src === 'map' && headingToWindow()) {
      const wait = () => {
        if (mzLock.on) return;
        if (headingToWindow() && performance.now() - ptrHist[ptrHist.length - 1].t < 200) intentT = setTimeout(wait, 120);   // 계속 슬라이더 쪽으로 움직이는 중
        else setHover(reg, reg ? 'map' : null);
      };
      intentT = setTimeout(wait, 160);
      return;
    }
    setHover(reg, reg ? 'map' : null);
  }
  function hoverAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (el && el.classList && el.classList.contains('dong')) setHover(regionOf(state.level, d3.select(el).datum()), 'map');
    else setHover(null);
  }

  function rehoverAtPointer() {
    if (!lastPtr || state.src === 'legend' || mzLock.on) return;
    const el = document.elementFromPoint(lastPtr[0], lastPtr[1]);
    if (el && el.classList && el.classList.contains('dong')) setHover(regionOf(state.level, d3.select(el).datum()), 'map');
    else if (state.src === 'map') setHover(null);
  }

  function zoomToRegion(reg) {
    const [[x0, y0], [x1, y1]] = reg.bounds;
    let k = Math.min(80, 0.8 / Math.max((x1 - x0) / W, (y1 - y0) / H));
    const next = reg.level === 0 ? CFG.levels.gu : reg.level === 1 ? CFG.levels.dong : 0;
    if (next) k = Math.max(k, next * 1.08);
    k = Math.max(1, k);
    const t = d3.zoomIdentity.translate(W / 2 - k * (x0 + x1) / 2, H / 2 - k * (y0 + y1) / 2).scale(k);
    svg.transition().duration(800).call(zoom.transform, t);
  }

  /* 칠하기: 배경 지도 위에 반투명 레이어를 얹는다.
   *   평소  : 지역별로 인구가 많을수록 진한 회색 (투명도)
   *   호버  : 해당 지역은 맑게 + 테두리, 나머지는 한 장의 어두운 막으로 덮음 */
  function applyFills() {
    if (!shadeSel) return;
    const h = state.hover;
    if (h) {
      shadeSel.style('fill-opacity', 0);
      let dim = pathCache.get('dim|' + h.key);
      // 화면 전체(서울 밖 배경 지도 포함)를 덮는 큰 사각형 + 호버한 지역을 구멍으로 (evenodd)
      if (dim === undefined) { dim = 'M-100000,-100000H100000V100000H-100000Z' + regionPath(h); pathCache.set('dim|' + h.key, dim); }
      dimPath.attr('d', dim).classed('on', true);
      hoverLine.attr('d', null);          // 호버한 지역은 테두리 없이
      setMesh(h);
      if (pathCache.size > 60) pathCache.delete(pathCache.keys().next().value);
    } else {
      dimPath.classed('on', false);
      hoverLine.attr('d', null);
      setMesh(null);
      const lv = state.level, lo = peerMin[lv], hi = peerMax[lv];
      shadeSel.style('fill-opacity', r => {
        if (!CFG.shadeByPopulation || CFG.mapMosaic) return 0;
        const u = Math.min(1, Math.max(0, (popOf(r) - lo) / ((hi - lo) || 1)));
        return (0.03 + 0.32 * u ** 1.1).toFixed(3);
      });
    }
    svg.classed('dimmed', !!h);
    $('#stage').classList.toggle('dim', !!h);
  }

  /* ============================================================
   *  5. 호버 → 좌측 세부정보 + 모자이크
   * ============================================================ */
  function setHover(reg, src) {
    if (state.hover === reg && state.src === (src || null)) return;
    state.hover = reg; state.src = src || null;
    applyFills(); updatePane(); updateMosaic(); scheduleMapMosaic();
  }

  function updatePane() {
    const reg = state.hover, show = !!reg && state.src === 'map';
    $('#hoverPane').classList.toggle('hidden', !show);
    $('#side').classList.toggle('hovering', show);
    if (!show) return;
    $('#hp-num').textContent = reg.num;
    $('#hp-name').textContent = reg.name;
    $('#hp-sub').textContent = reg.sub;
    $('#hp-when').textContent = `${hh(state.hour)} 기준 · ${['권역', '자치구', '행정동'][reg.level]}`;
    renderStats(reg);
  }

  function renderStats(reg) {
    const s = series.get(reg.key), h = state.hour, p = s[h];
    $('#hp-pop').textContent = fmt(p);

    // 24시간 곡선
    const w = 300, ht = 92, mx = Math.max(...s), mn = Math.min(...s);
    const x = i => (i / 23) * w, y = v => ht - 8 - ((v - mn) / Math.max(1, mx - mn || 1)) * (ht - 22);
    const line = d3.line().x((v, i) => x(i)).y(v => y(v)).curve(d3.curveMonotoneX);
    const area = d3.area().x((v, i) => x(i)).y0(ht - 8).y1(v => y(v)).curve(d3.curveMonotoneX);
    const sp = d3.select('#spark').html('');
    sp.append('path').attr('d', area(Array.from(s))).attr('fill', '#d6d6d6');
    sp.append('path').attr('d', line(Array.from(s))).attr('fill', 'none').attr('stroke', '#222').attr('stroke-width', 1.4).attr('vector-effect', 'non-scaling-stroke');
    sp.append('line').attr('x1', x(h)).attr('x2', x(h)).attr('y1', 0).attr('y2', ht - 8).attr('stroke', '#000').attr('stroke-width', 1).attr('vector-effect', 'non-scaling-stroke');
    sp.append('circle').attr('cx', x(h)).attr('cy', y(p)).attr('r', 3.2).attr('fill', '#000').attr('vector-effect', 'non-scaling-stroke');
    [0, 6, 12, 18, 23].forEach(t => sp.append('text').attr('x', x(t)).attr('y', ht + 6).attr('font-size', 8).attr('fill', '#888')
      .attr('text-anchor', t === 0 ? 'start' : t === 23 ? 'end' : 'middle').text(String(t).padStart(2, '0')));

    // 표 (막대 두 줄씩: 붉은 막대 = 이 지역 · 지금, 검은 막대 = 비교 기준)
    const peersArr = [...regions[reg.level].values()];
    const peers = peersArr.map(r => popOf(r, h)).sort((a, b) => b - a);
    const rank = peers.indexOf(p) + 1;
    const total = [...regions[0].values()].reduce((a, r) => a + popOf(r, h), 0);
    const seoulArea = [...regions[0].values()].reduce((a, r) => a + r.area, 0);
    const peakH = s.indexOf(mx), at0 = s[0] || 1;
    const share = p / total, maxShare = peers[0] / total;
    const dReg = p / reg.area, dSeoul = total / seoulArea;
    const diff = (p / at0 - 1) * 100;
    const groups = [
      ['인구 (명)', '지금 / 하루 최대', [[p / mx, fmt(p), 'a'], [1, `${fmt(mx)} · ${hh(peakH)}`, 'k']]],
      ['인구밀도 (명/km²)', '이 지역 / 서울 평균', [[dReg / Math.max(dReg, dSeoul), fmt(dReg), 'a'], [dSeoul / Math.max(dReg, dSeoul), fmt(dSeoul), 'k']]],
      ['00시 대비', `지금 / 00:00  (${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%)`, [[p / Math.max(p, at0), fmt(p), 'a'], [at0 / Math.max(p, at0), fmt(at0), 'k']]],
      ['서울 전체 대비', `비중 / 같은 단계 순위 ${rank}·${peers.length}`, [[share / maxShare, (share * 100).toFixed(1) + '%', 'a'], [(peers.length - rank + 1) / peers.length, `${rank} / ${peers.length}`, 'k']]],
    ];
    $('#hp-stats').innerHTML = groups.map(([t, sub, rows]) =>
      `<div class="dg"><div class="dt">${t} <small>${sub}</small></div>` +
      rows.map(([f, v, c]) => `<div class="dr ${c}"><span class="bar"><i style="width:${(Math.max(0.02, Math.min(1, f)) * 100).toFixed(1)}%"></i></span><b>${v}</b></div>`).join('') +
      `<div class="dticks"></div></div>`).join('');
  }

  /* 제목 폭을 슬라이더 폭에 맞춤 */
  const TITLE_FIT = 0.9;            // 제목 폭 = 슬라이더 폭 × 0.9
  function fitTitle() {
    const h1 = document.querySelector('#side h1'), sl = $('#slider');
    if (!h1 || !sl) return;
    h1.style.fontSize = '';
    const want = sl.getBoundingClientRect().width, have = h1.getBoundingClientRect().width;
    if (want > 0 && have > 0) h1.style.fontSize = (parseFloat(getComputedStyle(h1).fontSize) * want * TITLE_FIT / have).toFixed(2) + 'px';
  }

  /* ---------- 모자이크 ---------- */
  function updateMosaic() {
    const el = $('#mosaic'), reg = state.hover;
    el.classList.toggle('hidden', !reg);
    if (!reg) return;
    $('#mz-tag').textContent = reg.num;
    placeMosaic(reg);

    const canvas = $('#mz-canvas'), r = canvas.getBoundingClientRect();
    const Wc = Math.round(r.width), Hc = Math.round(r.height);
    if (Wc < 20) return;
    const pk = `${reg.key}|${Wc}x${Hc}`;
    let prep = mz.prepCache.get(pk);
    if (!prep) {
      prep = Mosaic.prepare(reg.dongs.map(i => ({ idx: i, geometry: D[i].geometry })), Wc, Hc);
      mz.prepCache.set(pk, prep);
      if (mz.prepCache.size > 40) mz.prepCache.delete(mz.prepCache.keys().next().value);
    }
    // 같은 단계 지역 중 최대 인구 대비 규모 → 칸 크기(격자 세밀도)
    const hi = peerMax[reg.level], lo = peerMin[reg.level];
    const u = Math.min(1, Math.max(0, (popOf(reg) - lo) / ((hi - lo) || 1))) ** 0.6;
    const seed = [...reg.key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);
    const res = Mosaic.render(canvas, prep, {
      u, thresholds, seed, bg: '#fff',
      density: i => dongPop[i * 24 + state.hour] / D[i].area,
    });
    el.dataset.cell = res.cell;
  }

  function placeMosaic(reg) {
    const el = $('#mosaic'), st = $('#stage').getBoundingClientRect();
    // 기본 위치(우측 상단)의 패널 영역을 계산해 지역 중심이 그 아래에 깔리면 좌측 하단으로 이동
    const pw = Math.min(st.width * 0.47, 640), ph = pw / 1.26 + 40;
    const left = st.width * 0.93 - pw, top = st.height * 0.14;
    const c = curT.apply(reg.pc);                       // 지역 중심의 화면 좌표(스테이지 기준)
    const hit = c[0] > left - 50 && c[0] < left + pw + 30 && c[1] > top - 30 && c[1] < top + ph;
    el.classList.toggle('alt', hit);
  }

  function buildMosaicLegend() { ['#mz-legend', '#map-legend'].forEach(sel => fillLegend($(sel))); }
  function fillLegend(box) {
    if (!box) return;
    box.innerHTML = '<span class="ttl">밀도 (명/km²)</span>';
    const th = thresholds, fmtK = v => v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k' : Math.round(v / 10) * 10;
    for (let c = 0; c < Mosaic.NCLS; c++) {
      const s = document.createElement('span');
      s.appendChild(Mosaic.legendGlyph(c, 15));
      s.append(c === 0 ? `<${fmtK(th[0])}` : c === Mosaic.NCLS - 1 ? `${fmtK(th[5])}+` : `${fmtK(th[c - 1])}–${fmtK(th[c])}`);
      box.appendChild(s);
    }
  }

  /* ============================================================
   *  6. 좌측 UI : 슬라이더 · 범례 · 재생
   * ============================================================ */
  function setHour(h) {
    state.hour = h;
    $('#readout').textContent = hh(h);
    const sl = $('#slider'); sl.value = h;
    const pct = h / 23;
    $('#readout').style.left = `calc(${pct} * (100% - 16px) + 8px)`;
    $('#vthumb').style.top = (pct * 100) + '%';
    $('#vlabel').textContent = hh(h);
    scheduleRender();
    scheduleMapMosaic();
  }
  let raf = 0;
  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!state.hover) applyFills();
      if (state.hover) { updatePane(); updateMosaic(); }
    });
  }

  /* 모자이크 창 안의 세로 슬라이더 (위 00시 → 아래 23시) */
  function initMosaicSlider() {
    const win = $('#mosaic'), vs = $('#vslider'), track = vs.querySelector('.vtrack');
    vs.addEventListener('pointerenter', () => { clearTimeout(intentT); if (state.hover && state.src === 'map') mzLock.on = true; });
    vs.addEventListener('pointerleave', e => {
      if (mzLock.drag) return;
      mzLock.on = false;
      hoverAtPoint(e.clientX, e.clientY);
    });
    const fromY = y => { const r = track.getBoundingClientRect(); return Math.round(Math.min(1, Math.max(0, (y - r.top) / r.height)) * 23); };
    vs.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      mzLock.drag = true; vs.setPointerCapture(e.pointerId); vs.classList.add('drag');
      setHour(fromY(e.clientY));
    });
    vs.addEventListener('pointermove', e => { if (mzLock.drag) setHour(fromY(e.clientY)); });
    const end = e => {
      if (!mzLock.drag) return;
      mzLock.drag = false; vs.classList.remove('drag');
      const r = win.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom + 40) { mzLock.on = false; hoverAtPoint(e.clientX, e.clientY); }
    };
    vs.addEventListener('pointerup', end);
    vs.addEventListener('pointercancel', end);
    vs.addEventListener('wheel', e => { e.preventDefault(); setHour(Math.min(23, Math.max(0, state.hour + (e.deltaY > 0 ? 1 : -1)))); }, { passive: false });
  }

  function buildLegend() {
    const ol = $('#legend');
    ZONES.forEach(z => {
      const li = document.createElement('li');
      li.innerHTML = `<b>${z.id}</b><span>${z.name} <i>— ${z.short}</i></span><em class="go">상세 →</em>`;
      li.title = '클릭하면 권역 상세 페이지로 이동';
      li.addEventListener('pointerenter', () => setHover(regions[0].get('z' + z.id), 'legend'));
      li.addEventListener('pointerleave', () => setHover(null));
      li.addEventListener('click', () => { location.href = 'detail.html?zone=' + z.id; });
      ol.appendChild(li);
    });
  }

  function togglePlay() {
    state.playing = !state.playing;
    clearInterval(state.timer);
    if (state.playing) state.timer = setInterval(() => setHour((state.hour + 1) % 24), 900);
  }

  function renderStatus() {
    const live = dataInfo.mode === 'live';
    $('#status').innerHTML = `<b>${live ? '● LIVE' : '○ DEMO'}</b> ${dataInfo.note}` +
      (live ? '' : '<br>※ 실제 생활인구가 아닌 가상 데이터입니다. (실패 원인은 개발자도구 콘솔 참고)') +
      (basemapInfo.label ? `<br>지도: ${basemapInfo.label}` : '');
  }

  /* ============================================================
   *  7. 시작
   * ============================================================ */
  async function main() {
    try {
      const bm = Basemap.init(CFG, $('#basemap')).then(info => { basemapInfo = info; });   // 배경 지도는 병렬로
      const geo = await loadGeo();
      normalize(geo);
      buildEdges();
      buildRegions();
      $('#loading').textContent = '생활인구 데이터를 불러오는 중…';
      dongPop = await loadPopulation();
      aggregate();

      MM.canvas = $('#mapmosaic'); MM.ctx = MM.canvas.getContext('2d');
      MM.id = document.createElement('canvas'); MM.idCtx = MM.id.getContext('2d', { willReadFrequently: true });
      MM.idCtx.imageSmoothingEnabled = false;
      initSvg();
      layout();
      buildLegend();
      initMosaicSlider();
      buildMosaicLegend();
      await bm;
      Basemap.sync(proj, curT, W, H);
      renderStatus();

      const sl = $('#slider');
      sl.addEventListener('input', () => setHour(+sl.value));
      window.addEventListener('keydown', e => { if (e.code === 'Space' && e.target.tagName !== 'BUTTON') { e.preventDefault(); togglePlay(); } });
      $('#zin').onclick = () => svg.transition().duration(300).call(zoom.scaleBy, 1.6);
      $('#zout').onclick = () => svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.6);
      $('#zreset').onclick = () => svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity);
      let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { Basemap.resize(); layout(); }, 150); });

      setHour(state.hour);
      svg.classed('lvl0', true);
      fitTitle();
      if (document.fonts) document.fonts.ready.then(fitTitle);
      window.addEventListener('resize', fitTitle);
      $('#loading').classList.add('done');
    } catch (e) {
      console.error(e);
      $('#loading').style.whiteSpace = 'pre-line';
      $('#loading').textContent = '⚠ ' + e.message;
    }
  }
  main();

  /* 디버그용 */
  window.__oclock = { state, D, regions, series, get thresholds() { return thresholds; }, setHover, setHour, zoomToRegion, get zoom() { return zoom; }, get svg() { return svg; } };
})();
