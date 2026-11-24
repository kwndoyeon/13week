/* ============================================================
 *  배경 지도 (MapLibre GL)
 *   - 지도 조작(확대·이동)은 지금처럼 d3.zoom 이 맡고, MapLibre 는 그 아래에서 "그림"만 그린다.
 *     → d3 변환값을 MapLibre 카메라(center, zoom)로 바꿔 매 프레임 맞춰 준다.
 *   - 1순위 Overture Maps PMTiles (수계·녹지·도로·건물), 실패하면 OpenFreeMap Positron.
 * ============================================================ */
const Basemap = (() => {
  let map = null, kind = 'none', label = '';

  /* ---------- Overture 스타일 (흑백 톤) ----------
   *  [평소, 호버 중] 두 가지 색. 호버하면 지도도 같이 어두워진다 (setDark) */
  const PAL = {
    bg: ['#f1f1ef', '#e2e2df'], landcover: ['#e6e7e3', '#d6d7d3'], landuse: ['#e4e5e1', '#d4d5d1'],
    water: ['#d2d5d8', '#bfc3c7'], roadCase: ['#d4d4d2', '#c2c2c0'], road: ['#ffffff', '#f4f4f3'],
    rail: ['#c6c6c4', '#b2b2b0'], bld: ['#e0e0dd', '#cfcfcc'], bldOut: ['#cfcfcc', '#bdbdba'],
  };
  const PAINT = [['bg', 'background-color', 'bg'], ['landcover', 'fill-color', 'landcover'], ['landuse', 'fill-color', 'landuse'],
    ['water', 'fill-color', 'water'], ['waterway', 'line-color', 'water'], ['road-case', 'line-color', 'roadCase'],
    ['road', 'line-color', 'road'], ['rail', 'line-color', 'rail'], ['building', 'fill-color', 'bld'], ['building', 'fill-outline-color', 'bldOut']];
  let dark = false, containerEl = null;
  function applyDark() {
    if (containerEl) containerEl.classList.toggle('dark', dark);
    if (!map || kind !== 'overture' || !map.isStyleLoaded()) return;
    for (const [id, prop, key] of PAINT) if (map.getLayer(id)) map.setPaintProperty(id, prop, PAL[key][dark ? 1 : 0]);
  }
  function setDark(d) { if (d === dark) return; dark = d; applyDark(); }
  const POLY = ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]];
  const LINE = ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]];
  const roadW = (major, minor) => ['interpolate', ['exponential', 1.6], ['zoom'],
    10, ['match', ['get', 'class'], ['motorway', 'trunk'], major * 0.5, ['primary', 'secondary'], major * 0.3, minor * 0.15],
    14, ['match', ['get', 'class'], ['motorway', 'trunk'], major * 2.2, ['primary', 'secondary'], major * 1.6, ['tertiary'], major * 1.1, minor],
    18, ['match', ['get', 'class'], ['motorway', 'trunk'], major * 12, ['primary', 'secondary'], major * 9, ['tertiary'], major * 7, minor * 5]];
  const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'living_street', 'unclassified', 'service', 'pedestrian'];

  function overtureStyle(src, layers) {
    const has = (s, id) => layers[s] && layers[s].includes(id);
    const L = [{ id: 'bg', type: 'background', paint: { 'background-color': PAL.bg[0] } }];
    if (has('base', 'land_cover')) L.push({ id: 'landcover', type: 'fill', source: 'base', 'source-layer': 'land_cover',
      filter: ['match', ['get', 'subtype'], ['forest', 'shrub', 'grass', 'wetland'], true, false],
      paint: { 'fill-color': PAL.landcover[0], 'fill-opacity': 0.9 } });
    if (has('base', 'land_use')) L.push({ id: 'landuse', type: 'fill', source: 'base', 'source-layer': 'land_use',
      filter: ['all', POLY, ['match', ['get', 'subtype'], ['park', 'recreation', 'protected', 'golf', 'cemetery', 'green'], true, false]],
      paint: { 'fill-color': PAL.landuse[0] } });
    if (has('base', 'water')) {
      L.push({ id: 'water', type: 'fill', source: 'base', 'source-layer': 'water', filter: POLY, paint: { 'fill-color': PAL.water[0] } });
      L.push({ id: 'waterway', type: 'line', source: 'base', 'source-layer': 'water', filter: LINE,
        paint: { 'line-color': PAL.water[0], 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 16, 3] } });
    }
    if (has('transportation', 'segment')) {
      const road = ['all', LINE, ['==', ['get', 'subtype'], 'road'], ['match', ['get', 'class'], ROAD_CLASSES, true, false]];
      L.push({ id: 'road-case', type: 'line', source: 'transportation', 'source-layer': 'segment', filter: road, minzoom: 12,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': PAL.roadCase[0], 'line-gap-width': roadW(1.4, 0.8) , 'line-width': 0.8 } });
      L.push({ id: 'road', type: 'line', source: 'transportation', 'source-layer': 'segment', filter: road,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': PAL.road[0], 'line-width': roadW(1.4, 0.8) } });
      L.push({ id: 'rail', type: 'line', source: 'transportation', 'source-layer': 'segment', minzoom: 11,
        filter: ['all', LINE, ['==', ['get', 'subtype'], 'rail']],
        paint: { 'line-color': PAL.rail[0], 'line-width': 1, 'line-dasharray': [3, 2] } });
    }
    if (has('buildings', 'building')) L.push({ id: 'building', type: 'fill', source: 'buildings', 'source-layer': 'building', minzoom: 13,
      paint: { 'fill-color': PAL.bld[0], 'fill-outline-color': PAL.bldOut[0], 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, 1] } });

    const sources = {};
    for (const s of Object.keys(src)) sources[s] = { type: 'vector', url: 'pmtiles://' + src[s],
      attribution: '© <a href="https://overturemaps.org" target="_blank">Overture Maps Foundation</a>, © OpenStreetMap contributors' };
    return { version: 8, sources, layers: L };
  }

  /* 가장 최근 릴리스 중 열리는 것 찾기 + 각 파일의 레이어 이름 읽기 */
  async function probeOverture(cfg) {
    const ov = cfg.overture;
    const open = async (rel, t) => {
      const url = `${ov.base}/${rel}/${t}.pmtiles`;
      const meta = await new pmtiles.PMTiles(url).getMetadata();
      return { url, ids: (meta.vector_layers || []).map(v => v.id) };
    };
    for (const rel of ov.releases) {
      try {
        const [base, tr] = await Promise.all([open(rel, 'base'), open(rel, 'transportation')]);   // 필수
        const src = { base: base.url, transportation: tr.url }, layers = { base: base.ids, transportation: tr.ids };
        if (ov.buildings) {
          try { const b = await open(rel, 'buildings'); src.buildings = b.url; layers.buildings = b.ids; }
          catch (e) { console.warn('[Seoul O’Clock] Overture 건물 레이어 생략:', e.message); }
        }
        console.info('[Seoul O’Clock] Overture', rel, layers);
        if (!base.ids.length && !tr.ids.length) throw new Error('레이어 없음');
        return { rel, src, layers };
      } catch (e) {
        console.warn('[Seoul O’Clock] Overture', rel, '실패:', e.message);
      }
    }
    throw new Error('Overture PMTiles 를 열 수 없습니다');
  }

  /** 초기화. 실패해도 throw 하지 않고 kind='none' 으로 끝난다. */
  async function init(cfg, container) {
    if (cfg.basemap === 'none' || typeof maplibregl === 'undefined') {
      if (cfg.basemap !== 'none') console.warn('[Seoul O’Clock] maplibre-gl 을 불러오지 못해 배경 지도 없이 진행합니다.');
      return { kind: 'none', label: '' };
    }
    let style = null;
    if (cfg.basemap === 'overture' && typeof pmtiles !== 'undefined') {
      try {
        const protocol = new pmtiles.Protocol();
        maplibregl.addProtocol('pmtiles', protocol.tile);
        const ov = await Promise.race([probeOverture(cfg),
          new Promise((_, rej) => setTimeout(() => rej(new Error('Overture 응답 시간 초과')), 9000))]);
        style = overtureStyle(ov.src, ov.layers);
        kind = 'overture'; label = `Overture Maps ${ov.rel.replace(/\.\d+$/, '')}`;
      } catch (e) { console.warn('[Seoul O’Clock]', e.message, '→ OpenFreeMap 사용'); }
    }
    if (!style) { style = cfg.openfreemapStyle; kind = 'openfreemap'; label = 'OpenFreeMap · © OpenStreetMap'; }
    containerEl = container;
    container.classList.toggle('mono', kind === 'openfreemap');      // OSM 스타일은 CSS 로 흑백 처리

    try {
      map = new maplibregl.Map({
        container, style, interactive: false, attributionControl: { compact: true },
        center: [126.99, 37.56], zoom: 10, minZoom: 0, maxZoom: 24,
        renderWorldCopies: false, fadeDuration: 0,
      });
      map.on('load', applyDark);
      map.on('error', e => console.warn('[Seoul O’Clock] 배경 지도:', e.error && e.error.message));
    } catch (e) {
      console.warn('[Seoul O’Clock] MapLibre 초기화 실패:', e.message);
      map = null; kind = 'none'; label = '';
    }
    return { kind, label };
  }

  /**
   * d3 상태 → MapLibre 카메라
   *  proj: d3.geoMercator (scale s 이면 지구 둘레 = 2πs px)
   *  t   : d3.zoomTransform
   *  MapLibre 는 512px 타일 기준 → 지구 둘레 = 512·2^z  ⇒  z = log2(2π·s·k / 512)
   */
  function sync(proj, t, W, H) {
    if (!map || !proj) return;
    const p = t.invert([W / 2, H / 2]);
    const ll = proj.invert(p);
    const zoom = Math.log2((2 * Math.PI * proj.scale() * t.k) / 512);
    map.jumpTo({ center: ll, zoom, bearing: 0, pitch: 0 });
  }
  function resize() { if (map) map.resize(); }

  return { init, sync, resize, setDark, get kind() { return kind; } };
})();
