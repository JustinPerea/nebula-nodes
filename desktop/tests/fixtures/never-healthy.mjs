#!/usr/bin/env node
/**
 * Fixture: starts an HTTP server but never returns the correct Nebula health
 * body. Used as NEBULA_DESKTOP_PYTHON to test health timeout behavior.
 *
 * Parses `--port <N>` from argv.
 *
 * Env:
 *   FIXTURE_HEALTH_BODY — override body (default: wrong-app JSON)
 *   FIXTURE_HEALTH_STATUS — override status (default 200)
 */
import http from 'node:http';
import process from 'node:process';

let port = 0;
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--port' && i + 1 < process.argv.length) {
    port = parseInt(process.argv[i + 1], 10);
  }
}
if (!port) {
  process.stderr.write('Fixture: no --port provided\n');
  process.exit(1);
}

const body =
  process.env.FIXTURE_HEALTH_BODY ??
  JSON.stringify({ status: 'ok', app: 'not-nebula', version: '0.1.0' });
const status = parseInt(process.env.FIXTURE_HEALTH_STATUS ?? '200', 10);

const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  } else {
    res.writeHead(404);
    res.end();
  }
});

// Handle server errors (e.g. EADDRINUSE) without crashing — the process
// stays alive so the health-timeout test can exercise the full budget.
server.on('error', (err) => {
  process.stderr.write(`Fixture server error: ${err.code}: ${err.message}\n`);
});

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`Never-healthy fixture on 127.0.0.1:${port}\n`);
});

// Keep the process alive even if the server fails to listen
setInterval(() => {}, 60_000);

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
