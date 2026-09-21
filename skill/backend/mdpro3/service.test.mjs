import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

async function launch(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./service.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  let error = ''; child.stderr.on('data', c => { error += c; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const send = object => child.stdin.write(JSON.stringify({ version: 1, session: 'test', ...object }) + '\n');
  const receive = async () => {
    const next = await Promise.race([lines.next(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('service_timeout')), 3000); timer.unref(); })]);
    assert.equal(next.done, false, error); return JSON.parse(next.value);
  };
  t.after(() => { child.kill(); server.closeAllConnections(); server.close(); });
  send({ type: 'start', config: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fake', allowAnonymousLocal: true, timeoutMs: 1000 } });
  assert.equal((await receive()).status, 'ok');
  return { child, send, receive };
}

test('stdio handshake, card text request, model reply, failure and recovery keep step identity', async t => {
  let calls = 0;
  const client = await launch(t, (req, res) => { req.resume();
    if (++calls === 2) return res.writeHead(429).end('sensitive upstream details');
    res.end(JSON.stringify({ choices: [{ message: { content: '{"action":0}' } }] }));
  });
  for (let step = 1; step <= 3; step++) {
    client.send({ type: 'decision', step, state: {}, packet: Buffer.from([13, 1, 30, 0, 0, 0]).toString('base64') });
    assert.equal((await client.receive()).type, 'cards');
    client.send({ type: 'cards_result', step, cards: [] });
    const progress = await client.receive();
    assert.equal(progress.type, 'progress'); assert.equal(progress.step, step); assert.equal(progress.modelCalls, step);
    const result = await client.receive();
    assert.equal(result.step, step); assert.equal(result.session, 'test');
    assert.equal(result.status, step === 2 ? 'fallback' : 'ok');
    assert.equal(result.metrics.modelCalls, step);
    assert.ok(!JSON.stringify(result).includes('sensitive'));
  }
  const exit = once(client.child, 'exit'); client.child.stdin.end(); await exit;
});

test('stale card replies close the session instead of applying them to another decision', async t => {
  const client = await launch(t, (req, res) => res.end());
  client.send({ type: 'decision', step: 2, state: {}, packet: Buffer.from([13, 1, 30, 0, 0, 0]).toString('base64') });
  assert.equal((await client.receive()).type, 'cards');
  const exit = once(client.child, 'exit'); client.send({ type: 'cards_result', step: 1, cards: [] }); await exit;
});

test('closing owner pipe terminates service during a pending HTTP request', async t => {
  let requested;
  const seen = new Promise(resolve => { requested = resolve; });
  const client = await launch(t, req => { req.resume(); requested(); });
  client.send({ type: 'decision', step: 1, state: {}, packet: Buffer.from([13, 1, 30, 0, 0, 0]).toString('base64') });
  await client.receive(); client.send({ type: 'cards_result', step: 1, cards: [] }); await seen;
  const exit = once(client.child, 'exit'); const started = Date.now(); client.child.stdin.end(); await exit;
  assert.ok(Date.now() - started < 1000);
});
