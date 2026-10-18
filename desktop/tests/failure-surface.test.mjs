import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAILURE_WINDOW_SIZE, failureSurfaceHtml } from '../failure-surface.mjs';
import { checkParamsVersions } from '../frontend-build.mjs';

const MAIN = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'main.mjs'), 'utf8');

function decode(url) {
  assert.ok(url.startsWith('data:text/html;base64,'));
  return Buffer.from(url.slice('data:text/html;base64,'.length), 'base64').toString('utf8');
}

/** The declarations of the `pre` rule in the page's style sheet. */
function preRule(html) {
  const match = html.match(/\npre\{([^}]*)\}/);
  assert.ok(match, 'no pre rule');
  return match[1];
}

test('shows the error heading and the message, escaped', () => {
  const err = new Error('bad <b>"thing"</b> & more');
  err.heading = 'The desktop frontend needs a rebuild';
  const html = decode(failureSurfaceHtml(err));
  assert.match(html, /<h1>The desktop frontend needs a rebuild<\/h1>/);
  assert.ok(html.includes('<pre>bad &lt;b&gt;&quot;thing&quot;&lt;/b&gt; &amp; more</pre>'));
});

test('falls back to the default heading, and takes a non-Error', () => {
  const html = decode(failureSurfaceHtml('plain text'));
  assert.match(html, /<h1>Backend startup failed<\/h1>/);
  assert.ok(html.includes('<pre>plain text</pre>'));
});

test('the message box can be scrolled and copied, and uses the window height', () => {
  // The rebuild command is the message's last line. The box used to stop at
  // half the (480x320) window, which hid it, and the drag region blocked
  // selecting it.
  const rule = preRule(decode(failureSurfaceHtml(new Error('x'))));
  assert.match(rule, /overflow:auto/);
  assert.match(rule, /user-select:text/);
  assert.match(rule, /-webkit-app-region:no-drag/);
  assert.match(rule, /max-height:calc\(100vh - 140px\)/);
  assert.doesNotMatch(rule, /50vh/);
});

test('the launch-check messages fit their box at the window size', () => {
  // A rough fit check: 13px monospace is about 7.8px a character, so the
  // 488px-wide text area holds about 60 characters a line at 19.5px a line.
  for (const [frontend, health] of [[0, { paramsVersion: 1 }], [2, { paramsVersion: 1 }], [1, {}]]) {
    const err = checkParamsVersions(frontend, health);
    const lines = err.message.split('\n')
      .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 60)), 0);
    const textHeight = lines * 19.5 + 32;
    assert.ok(textHeight <= FAILURE_WINDOW_SIZE.height - 140, `${err.type}: ${lines} lines need ${textHeight}px`);
  }
});

test('main.mjs grows the reused loading window to the failure size', () => {
  const show = MAIN.slice(MAIN.indexOf('function showFailure'), MAIN.indexOf('function createDisconnectedWindow'));
  assert.match(show, /loadingWindow\.setSize\(FAILURE_WINDOW_SIZE\.width, FAILURE_WINDOW_SIZE\.height\)/);
  assert.match(show, /\.\.\.FAILURE_WINDOW_SIZE/);
});
