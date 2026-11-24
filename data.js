/* ============================================================
 *  생활인구 데이터 레이어
 *   - PopData.loadLive()  : 서울 열린데이터광장 OpenAPI (행정동별 · 시간대별)
 *   - PopData.makeDemo()  : API 키가 없거나 실패했을 때 쓰는 가상 데이터
 * ============================================================ */
const PopData = (() => {
  const pad2 = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());

  class ApiError extends Error {
    constructor(code, msg) { super(`${code} ${msg || ''}`.trim()); this.code = code; }
  }

  function candidateDates(cfg) {
    if (cfg.date) return [cfg.date];
    const base = new Date();
    base.setDate(base.getDate() - cfg.lagDays);
    return Array.from({ length: cfg.tryDays }, (_, i) => {
      const d = new Date(base); d.setDate(base.getDate() - i); return ymd(d);
    });
  }

  /* { "서비스명": { list_total_count, RESULT:{CODE,MESSAGE}, row:[...] } }  형태를 벗겨낸다 */
  function unwrap(json, service) {
    let root = json[service];
    if (!root) {
      const k = Object.keys(json).find(k => json[k] && typeof json[k] === 'object' && ('row' in json[k] || 'RESULT' in json[k]));
      root = k ? json[k] : null;
    }
    const result = (root && root.RESULT) || json.RESULT;
    const code = result && result.CODE;
    if (code && code !== 'INFO-000') throw new ApiError(code, result.MESSAGE);
    if (!root || !Array.isArray(root.row)) throw new ApiError('NO_ROW', '응답에 row 가 없습니다');
    return { rows: root.row, total: Number(root.list_total_count) || root.row.length };
  }

  /* /{KEY}/json/{SERVICE}/{START}/{END}/{YMD}/{TT}/{H_DNG_CD} — 선택 인자는 앞에서부터 채운다 */
  async function fetchPage(cfg, service, params, start, end) {
    const tail = params.length ? '/' + params.map(encodeURIComponent).join('/') : '';
    const url = `${cfg.apiBase}/${cfg.apiKey}/json/${service}/${start}/${end}${tail}`;
    let res;
    try { res = await fetch(url); }
    catch (e) { throw new ApiError('NETWORK', 'CORS/네트워크 오류 (node server.js 로 실행했는지 확인)'); }
    if (!res.ok) throw new ApiError('HTTP_' + res.status, url.replace(cfg.apiKey, '***'));
    let json;
    try { json = await res.json(); } catch { throw new ApiError('BAD_JSON', '응답이 JSON 이 아닙니다 (인증키·서비스명 확인)'); }
    return unwrap(json, service);
  }

  /* 응답 필드 이름 (Spop250mLocalResdDong: H_DNG_CD / SPOP / TT). 다른 서비스도 대충 맞도록 정규식 후보 */
  function detectFields(row, cfg) {
    const keys = Object.keys(row);
    const has = k => k && keys.includes(k);
    const find = re => keys.find(k => re.test(k));
    return {
      code: has(cfg.fields.code) ? cfg.fields.code : (find(/^H_DNG_CD$/i) || find(/ADSTRD_CODE/i) || find(/DO?NG.*(CD|CODE)|ADM_?CD/i)),
      total: has(cfg.fields.total) ? cfg.fields.total : (find(/^SPOP$/i) || find(/^TOT_LVPOP_CO$/i) || find(/TOT.*LVPOP/i)),
      hour: has(cfg.fields.hour) ? cfg.fields.hour : (find(/^TT$/i) || find(/TMZON/i)),
      parts: keys.filter(k => /^[MF]\d\d$/.test(k) || /(MALE|FEMALE).*LVPOP/i.test(k)),
    };
  }
  function rowTotal(row, f) {
    if (f.total) { const v = Number(row[f.total]); if (Number.isFinite(v)) return v; }   // '*'(3명 이하) → 성·연령 합 또는 0
    return f.parts.reduce((s, k) => s + (Number(row[k]) || 0), 0);
  }
  function rowHour(row, f) {
    let h = parseInt(String(row[f.hour]).trim(), 10);
    if (h > 23 && h % 100 === 0) h /= 100;           // '1300' 형태 대비
    return h;
  }

  /* 하루(24시간 × 행정동) 를 1000건씩 받아 Map(행정동코드 → Float32Array(24)) 로 만든다 */
  async function fetchDay(cfg, service, date, onProgress) {
    const byCode = new Map();
    let fields = null;
    const eat = rows => {
      if (!rows.length) return;
      if (!fields) fields = detectFields(rows[0], cfg);
      if (!fields.code || !fields.hour) throw new ApiError('FIELDS', '행정동코드/시간 필드를 찾지 못했습니다. config.fields 를 지정하세요. 응답 필드: ' + Object.keys(rows[0]).join(','));
      for (const r of rows) {
        const code = String(r[fields.code]).trim();
        const hour = rowHour(r, fields);
        if (!(hour >= 0 && hour <= 23)) continue;
        let arr = byCode.get(code);
        if (!arr) { arr = new Float32Array(24); byCode.set(code, arr); }
        arr[hour] = rowTotal(r, fields);
      }
    };
    const first = await fetchPage(cfg, service, [date], 1, 1000);
    eat(first.rows);
    const pages = [];
    for (let s = 1001; s <= first.total; s += 1000) pages.push(s);
    let done = 1; const n = pages.length + 1;
    onProgress && onProgress(done, n);
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (pages.length) {
        const s = pages.shift();
        eat((await fetchPage(cfg, service, [date], s, s + 999)).rows);
        onProgress && onProgress(++done, n);
      }
    }));
    return byCode;
  }

  /* 자료가 있는 가장 최근 날짜 찾기: 날짜마다 1건만 요청해서 list_total_count 를 본다 (7일씩 병렬) */
  async function findDate(cfg, service, onStatus) {
    const dates = candidateDates(cfg);
    let partial = null;
    for (let i = 0; i < dates.length; i += 7) {
      const batch = dates.slice(i, i + 7);
      onStatus && onStatus(`생활인구 자료 날짜 찾는 중… ${batch[0]} ~ ${batch[batch.length - 1]}`);
      const totals = await Promise.all(batch.map(d =>
        fetchPage(cfg, service, [d], 1, 1).then(r => r.total).catch(e => { if (e.code === 'INFO-200') return 0; throw e; })));
      for (let j = 0; j < batch.length; j++) {
        if (totals[j] >= cfg.minRowsPerDay) return batch[j];
        if (totals[j] > 0 && !partial) partial = batch[j];
      }
    }
    if (partial) return partial;
    throw new ApiError('INFO-200', `최근 ${dates.length}일 동안 자료가 없습니다`);
  }

  const cacheKey = (service, date) => `seoulOclock:v3:${service}:${date}`;
  function readCache(service, date) {
    try {
      const o = JSON.parse(localStorage.getItem(cacheKey(service, date)));
      if (!o) return null;
      return new Map(o.codes.map((c, i) => [c, Float32Array.from(o.vals[i])]));
    } catch { return null; }
  }
  function writeCache(service, date, map) {
    try {
      const codes = [...map.keys()];
      localStorage.setItem(cacheKey(service, date), JSON.stringify({ codes, vals: codes.map(c => Array.from(map.get(c), Math.round)) }));
    } catch { /* 용량 초과 등은 무시 */ }
  }

  /** 실데이터 로드. 성공 시 {date, service, byCode} / 실패 시 throw */
  async function loadLive(cfg, onStatus) {
    if (!cfg.apiKey) throw new ApiError('NO_KEY', 'config.js 에 apiKey 가 비어 있습니다');
    const services = cfg.service ? [cfg.service] : cfg.serviceCandidates;
    const errors = [];
    for (const service of services) {
      try {
        const date = await findDate(cfg, service, onStatus);
        const cached = readCache(service, date);
        if (cached) return { date, service, byCode: cached };
        const byCode = await fetchDay(cfg, service, date, (d, n) => onStatus && onStatus(`생활인구 불러오는 중… ${date} (${d}/${n})`));
        if (!byCode.size) throw new ApiError('EMPTY', '받은 행이 없습니다');
        writeCache(service, date, byCode);
        return { date, service, byCode };
      } catch (e) {
        errors.push(`${service}: ${e.message}`);
        if (e.code === 'INFO-100' || e.code === 'INFO-300' || e.code === 'NETWORK') break;   // 인증키·네트워크 문제는 다른 서비스도 똑같다
      }
    }
    const err = new ApiError('ALL_FAILED', errors.slice(-4).join(' | '));
    err.all = errors;
    throw err;
  }

  /* ------------------------------------------------------------
   *  데모 데이터: 거주지는 밤에, 업무지구는 낮에 사람이 많아지는 패턴
   *  dongs: [{idx, gu, area(km²)}]  →  Float32Array(n*24)
   * ---------------------------------------------------------- */
  function makeDemo(dongs) {
    const rng = seed => { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };
    const hash = n => { n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); n = Math.imul(n ^ (n >>> 16), 0x45d9f3b); return ((n ^ (n >>> 16)) >>> 0) / 4294967296; };
    const bell = (h, mu, sd) => Math.exp(-0.5 * ((h - mu) / sd) ** 2);
    const out = new Float32Array(dongs.length * 24);
    dongs.forEach((d, i) => {
      const r = rng(i * 7919 + 13);
      const zid = (typeof ZONE_OF_GU !== 'undefined' && ZONE_OF_GU[d.gu]) ? ZONE_OF_GU[d.gu].id : 0;
      const biz = (DEMO_BIZ[d.gu] || 0.5) * (0.4 + 1.6 * r() ** 2);          // 동마다 편차
      const res = 9000 + 26000 * r() * Math.sqrt(d.area + 0.4) / 1.6;         // 거주 기반 인구
      const night = 0.5 + 0.3 * r();                                          // 낮에 빠져나가는 비율
      for (let h = 0; h < 24; h++) {
        const day = bell(h, 13.5, 3.8);                                        // 9~18시 활동
        const rush = 0.55 * bell(h, 8.5, 0.8) + 0.45 * bell(h, 18.5, 0.9);      // 출퇴근 시간 반짝
        const lunch = 0.35 * bell(h, 12.5, 0.7);
        const eve = bell(h, 20.5, 1.8) * 0.5;                                  // 저녁 상권
        const resid = res * (1 - night * (day + 0.4 * rush) + 0.15 * bell(h, 23, 2.5));
        const work = res * 1.6 * biz * (day + rush + lunch + eve * 0.6) + res * 0.06 * biz;
        // 권역 단위로 같이 출렁이는 편차(합쳐도 사라지지 않게) + 동 단위 작은 편차
        const jit = 1 + 0.26 * (hash(zid * 131 + h * 7 + 3) - 0.5) + 0.08 * (r() - 0.5);
        out[i * 24 + h] = Math.max(300, (resid + work) * jit);
      }
    });
    return out;
  }

  return { loadLive, makeDemo, ApiError };
})();
