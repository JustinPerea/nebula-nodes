#!/usr/bin/env node
/**
 * Fixture: serves a minimal HTTP server with the correct Nebula health body
 * and a WebSocket /ws endpoint that sends a graphSync first frame.
 *
 * Used as NEBULA_DESKTOP_PYTHON for readiness, signal-policy, cleanup,
 * no-auto-restart, and WS-handshake tests.
 *
 * Parses `--port <N>` from argv (the sidecar module passes uvicorn-style args).
 *
 * Env:
 *   FIXTURE_IGNORE_SIGTERM — "1" to ignore SIGTERM (for SIGKILL escalation test)
 *   FIXTURE_HEALTH_BODY    — override health response body (JSON string)
 *   FIXTURE_HEALTH_STATUS  — override health HTTP status (default 200)
 *   FIXTURE_EXIT_AFTER_MS  — exit after N ms (for no-auto-restart test)
 */
import http from 'node:http';
import crypto from 'node:crypto';
import process from 'node:process';

// Parse --port from argv
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

const healthBody = process.env.FIXTURE_HEALTH_BODY ??
  JSON.stringify({ status: 'ok', app: 'nebula', version: '0.1.0' });
const healthStatus = parseInt(process.env.FIXTURE_HEALTH_STATUS ?? '200', 10);

const server = http.createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(healthStatus, { 'Content-Type': 'application/json' });
    res.end(healthBody);
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.on('upgrade', (req, socket) => {
  if (req.url === '/ws') {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n',
    );
    // Send graphSync first frame (unmasked text frame)
    const payload = Buffer.from(
      JSON.stringify({ type: 'graphSync', nodes: [], edges: [] }),
    );
    const frame = Buffer.alloc(2 + payload.length);
    frame[0] = 0x81; // FIN + text opcode
    frame[1] = payload.length; // no mask, length < 126
    payload.copy(frame, 2);
    socket.write(frame);
  } else {
    socket.destroy();
  }
});

server.listen(port, '127.0.0.1', () => {
  // Signal readiness to stderr for debugging
  process.stderr.write(`Fixture listening on 127.0.0.1:${port}\n`);
});

// Signal handling
if (process.env.FIXTURE_IGNORE_SIGTERM === '1') {
  // Ignore SIGTERM — only SIGKILL can stop this process
  process.on('SIGTERM', () => {
    process.stderr.write('Fixture: ignoring SIGTERM\n');
  });
} else {
  // Cooperative: trap SIGTERM and exit 0
  process.on('SIGTERM', () => {
    process.stderr.write('Fixture: received SIGTERM, exiting 0\n');
    server.close(() => process.exit(0));
  });
}

// Optional auto-exit (for no-auto-restart test)
if (process.env.FIXTURE_EXIT_AFTER_MS) {
  const ms = parseInt(process.env.FIXTURE_EXIT_AFTER_MS, 10);
  setTimeout(() => {
    server.close(() => process.exit(0));
  }, ms);
}
