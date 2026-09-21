// Serves the dist/ page for local development.
import http from 'node:http';
import fs from 'node:fs/promises';

const PORT = 5173;
const dist = new URL('../dist/', import.meta.url);

// The only files the browser may request.
const FILES = {
  '/': new URL('index.html', dist),
  '/index.html': new URL('index.html', dist),
  '/app.js': new URL('app.js', dist),
  '/style.css': new URL('style.css', dist),
  '/config.json': new URL('config.json', dist),
  '/abi.json': new URL('abi.json', dist),
  '/ethers.js': new URL('ethers.js', dist),
  '/qrcode.js': new URL('qrcode.js', dist),
};

const CONTENT_TYPES = {
  html: 'text/html',
  js: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
};

http.createServer(async (req, res) => {
  const file = FILES[new URL(req.url, 'http://localhost').pathname];
  if (!file) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  try {
    const body = await fs.readFile(file);
    res.setHeader('Content-Type', CONTENT_TYPES[file.pathname.split('.').pop()]);
    res.end(body);
  } catch {
    res.writeHead(500);
    res.end('Cannot load file. Run npm install.');
  }
}).listen(PORT, 'localhost', () => console.log(`DairyTrace: http://localhost:${PORT}`));
