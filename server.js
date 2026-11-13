// Local development server for Raahi NOW.
// Serves the static frontend from the project root and routes /api/* to
// the same handlers the Vercel functions in /api use. No dependencies.
//
// Run:  npm start        (or: node server.js)
// Then: http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle } = require('./lib/api');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

const API_ROUTES = {
  '/api/markets': 'markets',
  '/api/drops': 'drops',
  '/api/unlock': 'unlock',
  '/api/asks': 'asks',
  '/api/answer': 'answer',
  '/api/bookings': 'bookings',
  '/api/wallet': 'wallet',
  '/api/topup': 'topup',
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (API_ROUTES[url.pathname]) {
    return handle(req, res, API_ROUTES[url.pathname]);
  }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(ROOT, decodeURIComponent(file));
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    return res.end('Not found');
  }
  res.setHeader('Content-Type', TYPES[path.extname(full)] || 'application/octet-stream');
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Raahi NOW (demo) running at http://localhost:${PORT}`);
});
