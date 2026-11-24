/* ============================================================
 *  Seoul O'Clock — 권역 상세 페이지  (detail.html?zone=1 ~ 9)
 *
 *   ┌──────── 낮 (06~17시) ────────┬ 시간 ┬──────── 밤 (18~05시) ────────┐
 *   10 ←──── 밀집도 ────────── 0      0 ────── 밀집도 ────────→ 10
 *   같은 줄 = 같은 "시" : 왼쪽은 오전/낮 h시, 오른쪽은 h+12시
 *   - 선그래프: 시간대별 상대 밀집도(0~10)
 *   - 상자(사진): 가운데에서부터 밀집도만큼 채움 → 사람이 많을수록 사진이 많이 들어감
 *
 *  데이터: 메인 지도와 같은 서울 생활인구 API(같은 캐시)를 쓰고,
 *          행정동코드 앞 5자리(자치구 코드)로 권역별 합계를 낸다 → 경계 GeoJSON 불필요
 * ============================================================ */
(() => {
  'use strict';
  const CFG = window.CONFIG;
  const $ = s => document.querySelector(s);

  /* 자치구 코드(행정동코드 앞 5자리) · 면적(km²) */
  const GU_CODE = {
    11110: '종로구', 11140: '중구', 11170: '용산구', 11200: '성동구', 11215: '광진구', 11230: '동대문구', 11260: '중랑구',
    11290: '성북구', 11305: '강북구', 11320: '도봉구', 11350: '노원구', 11380: '은평구', 11410: '서대문구', 11440: '마포구',
    11470: '양천구', 11500: '강서구', 11530: '구로구', 11545: '금천구', 11560: '영등포구', 11590: '동작구', 11620: '관악구',
    11650: '서초구', 11680: '강남구', 11710: '송파구', 11740: '강동구',
  };
  const GU_AREA = {
    '종로구': 23.91, '중구': 9.96, '용산구': 21.87, '성동구': 16.86, '광진구': 17.06, '동대문구': 14.22, '중랑구': 18.50,
    '성북구': 24.58, '강북구': 23.60, '도봉구': 20.65, '노원구': 35.44, '은평구': 29.71, '서대문구': 17.63, '마포구': 23.85,
    '양천구': 17.41, '강서구': 41.44, '구로구': 20.12, '금천구': 13.02, '영등포구': 24.55, '동작구': 16.35, '관악구': 29.57,
    '서초구': 46.98, '강남구': 39.50, '송파구': 33.88, '강동구': 24.59,
  };

  const params = new URLSearchParams(location.search);
  const zoneId = Math.min(9, Math.max(1, parseInt(params.get('zone'), 10) || 1));
  const ZONE = ZONES.find(z => z.id === zoneId);
  const state = { mode: params.get('mode') === 'city' ? 'city' : 'region' };
  let popByZone = null, densByZone = null, info = {}, photos = { day: [], night: [] };

  const SHOW_BLOCKS = false;   // 사진 상자(블록) 표시 여부 — 지금은 끔
  const DAY_HOURS = Array.from({ length: 12 }, (_, i) => 6 + i);           // 06 … 17
  const NIGHT_HOURS = DAY_HOURS.map(h => (h + 12) % 24);                   // 18 … 05
  const hh = h => String(h).padStart(2, '0') + ':00';
  const fmt = n => Math.round(n).toLocaleString('ko-KR');

  /* ---------- 머리 ---------- */
  function buildHead() {
    document.title = `Seoul O’Clock — ${ZONE.id}. ${ZONE.name}`;
    $('#cur-num').textContent = ZONE.id;
    $('#cur-name').textContent = ZONE.name;
    $('#cur-gus').textContent = ZONE.short;
    $('#zones').innerHTML = ZONES.map(z =>
      `<li class="${z.id === zoneId ? 'on' : ''}"><a href="detail.html?zone=${z.id}${state.mode === 'city' ? '&mode=city' : ''}"><b>${z.id}</b><span>${z.name} — <i>${z.short}</i></span></a></li>`).join('');
    document.querySelectorAll('.modes button').forEach(b => {
      b.classList.toggle('on', b.dataset.mode === state.mode);
      b.onclick = () => {
        state.mode = b.dataset.mode;
        const u = new URL(location); u.searchParams.set('mode', state.mode); history.replaceState(null, '', u);
        buildHead(); render();
      };
    });
  }

  /* ---------- 데이터 ---------- */
  async function loadData() {
    const sums = new Map(ZONES.map(z => [z.id, new Float64Array(24)]));
    try {
      if (CFG.forceDemo || params.has('demo')) throw new Error('데모 모드');
      const live = await PopData.loadLive(CFG, m => { $('#loading').textContent = m; });
      let hit = 0;
      live.byCode.forEach((arr, code) => {
        const gu = GU_CODE[String(code).slice(0, 5)], z = gu && ZONE_OF_GU[gu];
        if (!z) return;
        hit++;
        const s = sums.get(z.id);
        for (let h = 0; h < 24; h++) s[h] += arr[h];
      });
      if (hit < 100) throw new Error(`행정동 코드 매칭 실패 (${hit})`);
      info = { mode: 'live', date: live.date };
    } catch (e) {
      console.warn('[Seoul O’Clock] 실데이터 대신 데모 데이터 사용:', e.message);
      sums.forEach(s => s.fill(0));
      const gus = Object.keys(GU_AREA);
      const demo = PopData.makeDemo(gus.map(g => ({ gu: g, area: GU_AREA[g] })));
      gus.forEach((g, i) => { const s = sums.get(ZONE_OF_GU[g].id); for (let h = 0; h < 24; h++) s[h] += demo[i * 24 + h] * 12; });
      info = { mode: 'demo' };
    }
    popByZone = sums;
    densByZone = new Map(ZONES.map(z => {
      const area = z.gus.reduce((a, g) => a + GU_AREA[g], 0);
      return [z.id, Array.from(sums.get(z.id), p => p / area)];
    }));
  }

  /* 밀집도 0~10
   *  region: 이 권역의 하루 최저 → 0.5, 최고 → 10   (하루 변화가 잘 보임)
   *  city  : 9개 권역 × 24시간 중 최고 밀도 = 10    (권역끼리 비교) */
  function score(h) {
    const d = densByZone.get(zoneId);
    if (state.mode === 'city') {
      let mx = 0; densByZone.forEach(a => a.forEach(v => { if (v > mx) mx = v; }));
      return 10 * d[h] / (mx || 1);
    }
    const mn = Math.min(...d), mx = Math.max(...d);
    return 0.5 + 9.5 * (d[h] - mn) / ((mx - mn) || 1);
  }

  /* ---------- 사진 ---------- */
  async function loadPhotos() {
    const entry = (window.PHOTOS || {})[zoneId];
    if (entry && !Array.isArray(entry)) { photos = { day: entry.day || [], night: entry.night || entry.day || [] }; return; }
    let list = entry || [];
    if (!list.length) {
      const tries = Array.from({ length: 12 }, (_, i) => `photos/z${zoneId}/${String(i + 1).padStart(2, '0')}.jpg`);
      list = (await Promise.all(tries.map(src => new Promise(r => {
        const im = new Image(); im.onload = () => r(src); im.onerror = () => r(null); im.src = src;
      })))).filter(Boolean);
    }
    photos = { day: list, night: list };
  }

  const rng = seed => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  /* 가운데에서 바깥으로 length 만큼, 폭이 제각각인 상자 조각 */
  function pieces(length, unit, rand) {
    const out = [], GAP = 4;
    let at = 0;
    while (at < length - unit * 0.3) {
      let w = unit * (0.75 + 1.4 * rand());
      if (at + w > length || length - (at + w) < unit * 0.45) w = length - at;
      out.push([at, w]);
      at += w + GAP;
    }
    return out;
  }

  /* ---------- 차트 ---------- */
  function render() {
    const wrap = $('#chartWrap'), W = wrap.clientWidth;
    const CW = 78, P = (W - CW) / 2;                    // 가운데 시간 열 · 패널 폭
    const unit = P / 10;
    const TOP = 96, RH = Math.round(Math.max(104, Math.min(150, P / 5.2))), H = TOP + 12 * RH;   // 줄 높이를 키워 세로로 길게
    const xL = v => P - (v / 10) * P, xR = v => P + CW + (v / 10) * P;
    const svg = d3.select('#chart').attr('viewBox', `0 0 ${W} ${H}`).attr('height', H).html('');

    // 배경 띠: [시작, 끝, 낮 색, 밤 색, 이름]
    const BANDS = [[0, 2, '#b8b8b8', '#222', 'Low - 1'], [2, 5, '#dcdcdc', '#2e2e2e', 'Moderate - 2'], [5, 10, '#eeeeee', '#444', 'High - 3']];
    BANDS.forEach(([a, b, cd, cn, name]) => {
      svg.append('rect').attr('x', xL(b)).attr('y', 0).attr('width', xL(a) - xL(b)).attr('height', H).attr('fill', cd);
      svg.append('rect').attr('x', xR(a)).attr('y', 0).attr('width', xR(b) - xR(a)).attr('height', H).attr('fill', cn);
      svg.append('text').attr('class', 'band-label').attr('x', xL(b) + 2).attr('y', 18).attr('fill', '#333').text(name);
      svg.append('text').attr('class', 'band-label').attr('x', xR(b) - 2).attr('y', 18).attr('text-anchor', 'end').attr('fill', '#eee').text(name);
    });
    svg.append('text').attr('class', 'side-title').attr('x', P + CW / 2).attr('y', 18).attr('text-anchor', 'middle').attr('fill', '#999').text('낮 | 밤');

    // 축
    const AX = 58;
    [[xL, '#111', 'L'], [xR, '#fff', 'R']].forEach(([x, col, side]) => {
      const g = svg.append('g').attr('class', 'ax');
      g.append('line').attr('x1', x(0)).attr('x2', x(10)).attr('y1', AX).attr('y2', AX).attr('stroke', col).attr('stroke-width', 1.2);
      for (let v = 0; v <= 10; v++) {
        g.append('line').attr('x1', x(v)).attr('x2', x(v)).attr('y1', AX - 6).attr('y2', AX + 8).attr('stroke', col).attr('stroke-width', [0, 2, 5, 10].includes(v) ? 1.6 : 1);
        const anchor = v === 10 ? (side === 'L' ? 'start' : 'end') : v === 0 ? (side === 'L' ? 'end' : 'start') : 'middle';
        g.append('text').attr('x', x(v) + (v === 10 ? (side === 'L' ? 1 : -1) : 0)).attr('y', AX - 11).attr('text-anchor', anchor)
          .attr('fill', col).attr('font-weight', [0, 2, 5, 10].includes(v) ? 600 : 400).text(v);
      }
    });

    const rowY = i => TOP + i * RH;
    const sDay = DAY_HOURS.map(score), sNight = NIGHT_HOURS.map(score);

    // 사진 상자
    const gBox = svg.append('g');
    if (SHOW_BLOCKS) [['day', sDay, xL, -1], ['night', sNight, xR, 1]].forEach(([side, sc, x, dir]) => {
      const list = photos[side], rand = rng(zoneId * 977 + (dir > 0 ? 31 : 7));
      const order = list.map((p, i) => [rand(), p]).sort((a, b) => a[0] - b[0]).map(a => a[1]);
      let k = 0;
      // 상자는 일부 줄에만: 밀집도가 높을수록 들어갈 확률↑, 최소 3줄
      const pick = rng(zoneId * 613 + (dir > 0 ? 5 : 2));
      const has = sc.map(v => pick() < 0.22 + 0.5 * (v / 10));
      const want = 3 - has.filter(Boolean).length;
      if (want > 0) sc.map((v, i) => [v, i]).filter(([, i]) => !has[i]).sort((a, b) => b[0] - a[0]).slice(0, want).forEach(([, i]) => { has[i] = true; });
      sc.forEach((v, i) => {
        if (!has[i]) return;
        const y = rowY(i) + 10, h = RH - 20;
        pieces((v / 10) * P - 4, unit, rand).forEach(([at, w]) => {
          const x0 = dir < 0 ? x(0) - 4 - at - w : x(0) + 4 + at;
          if (order.length) {
            gBox.append('image').attr('href', order[k++ % order.length]).attr('x', x0).attr('y', y).attr('width', w).attr('height', h)
              .attr('preserveAspectRatio', 'xMidYMid slice').attr('class', side === 'night' ? 'photo-night' : null);
          } else {
            gBox.append('rect').attr('x', x0).attr('y', y).attr('width', w).attr('height', h).attr('fill', side === 'day' ? '#fff' : '#000');
          }
        });
      });
    });

    // 시간 라벨
    DAY_HOURS.forEach((h, i) => {
      svg.append('text').attr('class', 'tlabel').attr('x', P + CW / 2).attr('y', rowY(i) + 4).attr('text-anchor', 'middle').text(hh(h));
      svg.append('text').attr('class', 'tlabel-sub').attr('x', P + CW / 2).attr('y', rowY(i) + 18).attr('text-anchor', 'middle').text(hh(NIGHT_HOURS[i]));
    });

    // 선그래프
    const tip = $('#tip');
    [[sDay, xL, DAY_HOURS], [sNight, xR, NIGHT_HOURS]].forEach(([sc, x, hours]) => {
      const pts = sc.map((v, i) => [x(v), rowY(i)]);
      svg.append('path').attr('class', 'pline').attr('d', d3.line()(pts));
      svg.selectAll(null).data(pts).join('rect').attr('class', 'pt')
        .attr('x', p => p[0] - 4.5).attr('y', p => p[1] - 4.5).attr('width', 9).attr('height', 9)
        .on('pointerenter', (e, p) => {
          const i = pts.indexOf(p), h = hours[i];
          tip.innerHTML = `<b>${hh(h)}</b> · ${fmt(popByZone.get(zoneId)[h])}명<br>밀집도 ${sc[i].toFixed(1)} / 10`;
          tip.style.left = p[0] + 'px'; tip.style.top = p[1] + 'px';
          tip.classList.remove('hidden');
        })
        .on('pointerleave', () => tip.classList.add('hidden'));
    });
  }

  async function main() {
    buildHead();
    try {
      await Promise.all([loadData(), loadPhotos()]);
      render();
      $('#loading').classList.add('hidden');
      let t; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(render, 120); });
    } catch (e) {
      console.error(e);
      $('#loading').textContent = '⚠ ' + e.message;
    }
  }
  main();
  window.__detail = { state, get dens() { return densByZone; }, render };
})();
