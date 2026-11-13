#!/usr/bin/env -S pnpm tsx
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 7777);
const LOG_FILE = path.resolve(process.env.LOG_FILE ?? '/tmp/debug-log.log');

// 启动时清空文件，每次会话日志干净
fs.writeFileSync(LOG_FILE, '');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = '';
  req.on('data', chunk => {
    body += chunk;
  });
  req.on('end', () => {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${body}\n`);
    res.writeHead(200);
    res.end('OK');
  });
});

server.listen(PORT, () => {
  console.log(`[debugger/log-server] listening on http://localhost:${PORT}`);
  console.log(`[debugger/log-server] writing to ${LOG_FILE}`);
});
