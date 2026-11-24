/* 정적 파일 서버 + 서울 열린데이터광장 API 프록시 (의존성 없음)
 *   node server.js            → http://localhost:3000
 *   /api/{KEY}/json/...       → http://openapi.seoul.go.kr:8088/{KEY}/json/...   (CORS·mixed-content 우회)
 *
 *   날짜가 들어간 정상 응답은 .cache/ 폴더에 저장해 두고 다시 쓰기 때문에,
 *   한 번 불러온 날짜는 API 서버가 느리거나 멈춰도 그대로 뜹니다. (발표 때 안전)  */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const UPSTREAM = process.env.SEOUL_API || 'http://openapi.seoul.go.kr:8088';
const CACHE_DIR = path.join(__dirname, '.cache');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.geojson': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function proxy(req, res) {
  const tail = req.url.slice(4);                                     // '/{KEY}/json/...'
  // 캐시 키에서는 인증키를 빼고, 날짜(YYYYMMDD)가 있는 요청만 캐시
  const noKey = tail.replace(/^\/[^/]+/, '');
  const cacheable = /\/\d{8}(\/|$)/.test(noKey);
  const file = path.join(CACHE_DIR, crypto.createHash('sha1').update(noKey).digest('hex') + '.json');
  if (cacheable && fs.existsSync(file)) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Cache': 'HIT' });
    return fs.createReadStream(file).pipe(res);
  }
  const up = http.get(UPSTREAM + tail, { timeout: 20000 }, upRes => {
    const chunks = [];
    upRes.on('data', c => chunks.push(c));
    upRes.on('end', () => {
      const body = Buffer.concat(chunks);
      res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || 'application/json; charset=utf-8' });
      res.end(body);
      if (cacheable && upRes.statusCode === 200 && body.includes('"INFO-000"') && body.includes('"row"')) {
        fs.mkdir(CACHE_DIR, { recursive: true }, () => fs.writeFile(file, body, () => {}));
      }
    });
  });
  up.on('timeout', () => up.destroy(new Error('upstream timeout')));
  up.on('error', e => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ RESULT: { CODE: 'PROXY', MESSAGE: e.message } }));
  });
}

http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return proxy(req, res);
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(__dirname, path.normalize(p));
  if (!file.startsWith(__dirname + path.sep) || file.startsWith(CACHE_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, () => console.log(`Seoul O'Clock → http://localhost:${PORT}   (API: ${UPSTREAM})`));
