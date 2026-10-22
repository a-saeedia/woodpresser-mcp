/**
 * What a user sees when the site answers but refuses them.
 *
 * These are the two support tickets that will dominate: a rejected Application
 * Password (wrong password or a host stripping the Authorization header) and a
 * bridge token that no longer matches. Both must name the fix, not the status
 * code. A fake WordPress lets us assert the exact wording without a real host.
 *
 * The CLI runs async (not execFileSync): the fake site lives in this process, so
 * blocking the event loop here would deadlock the request it is answering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'dist', 'cli.js');

function startSite(routes) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const handler = routes[path];
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'rest_no_route', message: 'No route', data: { status: 404 } }));
      return;
    }
    const [status, body] = handler(req);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => ready({ server, port: server.address().port }));
  });
}

/**
 * Close the listener and kill keep-alive sockets.
 *
 * undici keeps connections alive after the client exits; without this the test
 * process waits on them and the runner never reports.
 */
async function stop(server) {
  await new Promise((done) => server.close(done));
  server.closeAllConnections?.();
}

async function doctor(port) {
  const { stdout } = await run(process.execPath, [cli, 'doctor'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      NO_COLOR: '1',
      WOODPRESSER_SITE_URL: `http://127.0.0.1:${port}`,
      WOODPRESSER_USER: 'admin',
      WOODPRESSER_APP_PASSWORD: 'abcd efgh 1234 ijkl mnop 5678',
      WOODPRESSER_BRIDGE_TOKEN: 'token',
      WOODPRESSER_MODES: 'core,php',
      WOODPRESSER_CONFIG: join(root, '.does-not-exist.json'),
    },
  });
  return stdout;
}

test('a rejected password explains both causes and gives a curl test', async () => {
  const { server, port } = await startSite({
    '/wp-json/': () => [200, { name: 'Fake Site' }],
    '/wp-json/wp/v2/users/me': () => [
      401,
      { code: 'rest_not_logged_in', message: 'Sorry, you are not allowed.', data: { status: 401 } },
    ],
  });
  try {
    const out = await doctor(port);
    assert.match(out, /answers REST but rejects the credentials/);
    assert.match(out, /Wrong password/);
    assert.match(out, /strips the Authorization header/);
    assert.match(out, /curl -sS -u/, 'names the one command that separates the two causes');
    assert.match(out, /HTTP_AUTHORIZATION/, 'gives the .htaccess fix');
    assert.match(out, /Not usable yet/);
    // The table comes first; the explanation reads as a footnote to it.
    assert.ok(out.indexOf('Auth') < out.indexOf('answers REST'), 'diagnosis follows the table');
  } finally {
    await stop(server);
  }
});

test('an unreachable REST index points at the URL, not the password', async () => {
  const server = createServer((req, res) => {
    res.writeHead(500, { 'content-type': 'text/html' });
    res.end('<html>maintenance</html>');
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address();
  try {
    const out = await doctor(port);
    assert.match(out, /did not answer \/wp-json\//);
    assert.doesNotMatch(out, /Wrong password/, 'do not send them hunting for a password when the site is down');
  } finally {
    await stop(server);
  }
});

test('a token mismatch tells the user to run claim', async () => {
  const { server, port } = await startSite({
    '/wp-json/': () => [200, { name: 'Fake Site' }],
    '/wp-json/wp/v2/users/me': () => [200, { id: 1, slug: 'admin', name: 'Admin' }],
    '/wp-json/woodpresser/v1/ping': () => [
      403,
      { code: 'woodpresser_bad_token', message: 'Missing or invalid X-Woodpresser-Token header.', data: { status: 403 } },
    ],
  });
  try {
    const out = await doctor(port);
    assert.match(out, /Bridge token mismatch/);
    assert.match(out, /woodpresser bridge claim/);
    assert.match(out, /Core works/);
  } finally {
    await stop(server);
  }
});

test('a missing bridge route names the nested-folder trap', async () => {
  const { server, port } = await startSite({
    '/wp-json/': () => [200, { name: 'Fake Site' }],
    '/wp-json/wp/v2/users/me': () => [200, { id: 1, slug: 'admin', name: 'Admin' }],
  });
  try {
    const out = await doctor(port);
    assert.match(out, /rest_no_route|does not exist/);
    assert.match(out, /nested folder/);
  } finally {
    await stop(server);
  }
});
