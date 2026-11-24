/* ============================================================
 *  Seoul O'Clock 설정 파일
 *  ① apiKey 가 있으면 실데이터(서울 생활인구 API)로 동작합니다.
 *  ② 키가 없거나 API 호출이 실패하면 자동으로 "데모 데이터"로 동작합니다.
 * ============================================================ */
window.CONFIG = {
  // 서울 열린데이터광장(data.seoul.go.kr) → 인증키
  apiKey: '67414a696e6b647936394f6b4b6765',

  // 'node server.js' 로 실행하면 /api 가 서울시 API로 프록시됩니다 (CORS·http 문제 해결).
  apiBase: '/api',

  // [내국인] 행정동별 서울 생활인구(250m)  (OA-23016)
  //   http://openapi.seoul.go.kr:8088/{KEY}/json/Spop250mLocalResdDong/{시작}/{끝}/{YMD}/{TT}/{H_DNG_CD}
  //   응답: YMD(일자) · TT(시간) · H_DNG_CD(행정동코드) · SPOP(생활인구합계) · M00~F70(성·연령별)
  service: 'Spop250mLocalResdDong',
  serviceCandidates: ['Spop250mLocalResdDong'],

  // 조회 날짜(YYYYMMDD). 비우면 (오늘 - lagDays)부터 거꾸로 tryDays 일 동안 자료가 있는 가장 최근 날을 찾습니다.
  // (OpenAPI 는 최근 2개월치만 제공)
  date: '',
  lagDays: 3,
  tryDays: 70,
  minRowsPerDay: 24 * 350,   // 하루치가 다 들어온 날만 사용 (행정동 ~427개 × 24시간)

  // 응답 필드명
  fields: { code: 'H_DNG_CD', total: 'SPOP', hour: 'TT' },

  // 서울 행정동 경계 GeoJSON (앞에서부터 시도). data/seoul_dong.geojson 으로 저장해 두면 오프라인에서도 동작.
  geoUrls: [
    'data/seoul_dong.geojson',
    'https://raw.githubusercontent.com/raqoon886/Local_HangJeongDong/master/hangjeongdong_%EC%84%9C%EC%9A%B8%ED%8A%B9%EB%B3%84%EC%8B%9C.geojson',
  ],

  /* ---------- 배경 지도 ----------
   *  'overture'    : Overture Maps PMTiles (도로·수계·건물·녹지)  — 실패하면 openfreemap 으로 자동 전환
   *  'openfreemap' : OpenFreeMap Positron (OSM 기반, 키 불필요)
   *  'none'        : 배경 지도 없이 행정구역만
   */
  basemap: 'overture',
  overture: {
    // 최신 릴리스부터 차례로 시도 (https://docs.overturemaps.org/blog/tags/releases/)
    releases: ['2026-11-18.0', '2026-10-21.0', '2026-09-23.0', '2026-08-19.0'],
    base: 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles',
    buildings: true,
  },
  openfreemapStyle: 'https://tiles.openfreemap.org/styles/positron',

  forceDemo: false,            // true 면 API 호출 없이 데모 데이터
  shadeByPopulation: true,     // (mapMosaic 가 켜져 있으면 무시)
  mapMosaic: true,             // 호버하지 않아도 서울 전체를 인구 모자이크로 채움
  // 전체 지도 모자이크 칸 크기(px, 인구 적음 → 많음). [권역 단계, 자치구 단계, 행정동 단계]
  mapCell: [{ max: 8, min: 5 }, { max: 10, min: 5 }, { max: 14, min: 6 }],     // 호버 전에도 인구가 많은 지역을 살짝 진하게
  levels: { gu: 2.2, dong: 5.0 }, // 확대 배율이 이 값을 넘으면 구 → 행정동 단위로 전환
};
