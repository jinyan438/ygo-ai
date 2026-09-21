import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { StoryPolicy, validateConfig } from './policy.mjs';

const config = extra => validateConfig({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'test', allowAnonymousLocal: true, ...extra }, {});
const request = extra => ({ session: 'duel', step: 1, packet: Buffer.from([13, 1, 30, 0, 0, 0]).toString('base64'), state: {}, ...extra });
const reply = choice => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(choice) } }] }));

test('endpoint normalization, HTTPS, model/key validation and bounded settings', () => {
  assert.equal(config().endpoint, 'http://127.0.0.1:1234/v1/chat/completions');
  assert.equal(config({ baseUrl: 'http://localhost/chat/completions' }).endpoint, 'http://localhost/chat/completions');
  assert.equal(config({ timeoutMs: 1e9, maxModelCalls: -1 }).timeoutMs, 300000);
  assert.equal(config({ maxModelCalls: -1 }).maxModelCalls, 1);
  for (const baseUrl of ['file:///secret', 'http://remote.example', 'https://a:secret@host', 'https://host?key=secret'])
    assert.throws(() => config({ baseUrl }));
  assert.throws(() => config({ baseUrl: 'https://remote.example', allowAnonymousLocal: true }), /missing_api_key/);
  assert.throws(() => config({ model: '' }), /missing_model/);
});

test('model choice is validated and correlated; auth never enters prompt', async () => {
  let body;
  const p = new StoryPolicy({ ...config(), key: 'local-test-secret' }, { fetchImpl: async (url, options) => {
    body = JSON.parse(options.body);
    assert.equal(options.headers.Authorization, 'Bearer local-test-secret');
    assert.equal(options.redirect, 'error'); return reply({ action: 0, plan: 'Attack for lethal.' });
  } });
  const result = await p.decide(request(), async () => []);
  assert.equal(result.status, 'ok'); assert.equal(result.session, 'duel'); assert.equal(result.step, 1);
  assert.equal(Buffer.from(result.response, 'base64').readInt32LE(), 1);
  assert.ok(!JSON.stringify(body).includes('local-test-secret'));
  assert.equal(p.strategy.plan, null, 'a follow-up yes/no answer cannot introduce a turn plan');
});

test('one repair attempt for malformed or illegal output', async () => {
  let calls = 0;
  const p = new StoryPolicy(config(), { fetchImpl: async () => reply({ action: calls++ ? 1 : 9 }) });
  assert.equal((await p.decide(request(), async () => [])).status, 'ok'); assert.equal(calls, 2);
  const bad = new StoryPolicy(config(), { fetchImpl: async () => reply({ action: '0' }) });
  assert.equal((await bad.decide(request(), async () => [])).status, 'fallback'); assert.equal(bad.calls, 2);
});

test('single forced response needs no API call or card lookup', async () => {
  const p = new StoryPolicy(config(), { fetchImpl: () => { throw new Error('unexpected'); } });
  const result = await p.decide(request({ packet: Buffer.from([19, 1, 1, 0, 0, 0, 1]).toString('base64') }), () => { throw new Error('unexpected'); });
  assert.equal(result.source, 'automatic'); assert.equal(p.calls, 0);
});

test('HTTP failures are sanitized and circuit opens, then recovers', async () => {
  let now = 1000, calls = 0;
  const p = new StoryPolicy(config({ maxFailures: 1, cooldownMs: 1000 }), { clock: () => now,
    fetchImpl: async () => ++calls === 1 ? new Response('provider secret data', { status: 429 }) : reply({ action: 0 }) });
  assert.equal((await p.decide(request(), async () => [])).reason, 'http_429');
  assert.equal((await p.decide(request(), async () => [])).reason, 'circuit_open');
  assert.equal(calls, 1); now += 1001;
  assert.equal((await p.decide(request(), async () => [])).source, 'model');
});

test('closed local port is distinguished from invalid model output without leaking errors', async () => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const p = new StoryPolicy(config({ baseUrl: `http://127.0.0.1:${port}`, maxFailures: 1 }));
  assert.equal((await p.decide(request(), async () => [])).reason, 'connection_refused');
  assert.equal((await p.decide(request(), async () => [])).reason, 'circuit_open');
  assert.equal(p.calls, 1);
  for (const [code, expected] of [['ENOTFOUND', 'host_not_found'], ['ECONNREFUSED', 'connection_refused'], ['ETIMEDOUT', 'model_timeout']]) {
    const q = new StoryPolicy(config(), { fetchImpl: async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('private key and URL'), { code }) });
    } });
    const result = await q.decide(request(), async () => []);
    assert.equal(result.reason, expected); assert.ok(!JSON.stringify(result).includes('private key'));
  }
});

test('llama.cpp thinking controls use its chat template and preserve provider mode', async () => {
  for (const mode of ['disabled', 'enabled', 'provider']) {
    const p = new StoryPolicy(config({ thinkingApi: 'llamacpp', thinkingMode: mode }), { fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.thinking, undefined); assert.equal(body.reasoning_effort, undefined);
      assert.deepEqual(body.chat_template_kwargs, mode === 'provider' ? undefined : { enable_thinking: mode === 'enabled' });
      return reply({ action: 0 });
    } });
    assert.equal((await p.decide(request(), async () => [])).status, 'ok');
  }
  assert.throws(() => config({ thinkingApi: 'wrong' }), /invalid_thinking_api/);
});

test('invalid JSON, illegal choices and truncated output have distinct sanitized reasons', async () => {
  for (const [content, finish, expected] of [['private invalid output', 'stop', 'invalid_model_json'],
    ['{"action":999}', 'stop', 'invalid_model_choice'], ['', 'length', 'output_truncated']]) {
    const p = new StoryPolicy(config(), { fetchImpl: async () => new Response(JSON.stringify({ choices: [
      { finish_reason: finish, message: { content, reasoning_content: 'private reasoning' } } ] })) });
    const result = await p.decide(request(), async () => []);
    assert.equal(result.reason, expected); assert.ok(!JSON.stringify(result).includes('private'));
    assert.equal(p.calls, 2);
  }
});

test('billing and authentication failures stop further paid attempts in this duel', async () => {
  for (const status of [401, 402, 403]) {
    const p = new StoryPolicy(config(), { fetchImpl: async () => new Response('private account detail', { status }) });
    for (let i = 0; i < 3; i++) assert.equal((await p.decide(request(), async () => [])).reason, `http_${status}`);
    assert.equal(p.calls, 1);
  }
});

test('budgets stop repeated calls and oversized prompts', async () => {
  const p = new StoryPolicy(config({ maxModelCalls: 1 }), { fetchImpl: async () => reply({ action: 0 }) });
  await p.decide(request(), async () => []);
  assert.equal((await p.decide(request(), async () => [])).reason, 'call_budget');
  const large = new StoryPolicy(config({ maxPromptChars: 12000 }));
  assert.equal((await large.decide(request({ state: { text: 'a'.repeat(13000) } }), async () => [])).reason, 'context_budget');
  assert.equal(large.calls, 0);
});

test('oversized provider response is rejected without reflecting its content', async () => {
  const p = new StoryPolicy(config(), { fetchImpl: async () => new Response('x'.repeat(270000)) });
  const result = await p.decide(request(), async () => []);
  assert.equal(result.reason, 'model_error'); assert.ok(JSON.stringify(result).length < 400);
});

test('adaptive DeepSeek default is explicit and generic endpoints retain provider defaults', () => {
  const input = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
  const fast = validateConfig(input, { STORY_AI_API_KEY: 'test-key' });
  assert.equal(fast.thinkingMode, 'adaptive'); assert.equal(fast.maxTokens, 768); assert.equal(fast.timeoutMs, 12000);
  assert.equal(config().thinkingMode, 'provider');
  assert.throws(() => config({ thinkingMode: 'typo' }), /invalid_thinking_mode/);
});

test('request options, public summary and attempt metrics survive a repair', async () => {
  const progress = []; let attempts = 0, now = 100;
  const p = new StoryPolicy({ ...config({ thinkingMode: 'disabled' }), key: 'local-test-secret' }, {
    clock: () => now,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.max_tokens, 768);
      const cards = JSON.parse(body.messages[1].content).cards;
      assert.deepEqual(cards[0].strings, { 1: 'effect' });
      now += 500; attempts++;
      return new Response(JSON.stringify({ usage: { completion_tokens: 60, completion_tokens_details: { reasoning_tokens: 0 } },
        choices: [{ message: { reasoning_content: 'private reasoning must never leave the provider envelope',
          content: JSON.stringify({ action: attempts === 1 ? 99 : 0, summary: '<b>行动</b>\nlocal-test-secret sk-abcd1234567890' }) } }] }));
    }
  });
  const result = await p.decide(request(), async () => [{ code: 1, strings: ['', 'effect', ''] }], undefined, event => progress.push(event));
  assert.equal(result.status, 'ok'); assert.deepEqual(progress.map(x => x.modelCalls), [1, 2]);
  assert.equal(result.metrics.modelCalls, 2); assert.equal(result.metrics.apiCalls, 2);
  assert.equal(result.metrics.elapsedMs, 1000); assert.equal(result.metrics.completionTokens, 120);
  assert.equal(result.summary, '是'); assert.ok(result.intention.includes('[redacted]')); assert.ok(!/[<>\n]/.test(result.intention));
  assert.ok(!JSON.stringify(result).includes('local-test-secret')); assert.ok(!JSON.stringify(result).includes('private reasoning'));
  const forced = await p.decide(request({ packet: Buffer.from([19, 1, 1, 0, 0, 0, 1]).toString('base64') }), () => assert.fail());
  assert.equal(forced.metrics.apiCalls, 0); assert.equal(forced.metrics.modelCalls, 2);
});

test('a provider failure still reports the request attempt and never invents a summary', async () => {
  const p = new StoryPolicy(config(), { fetchImpl: async (url, options) => {
    assert.equal(JSON.parse(options.body).thinking, undefined);
    return new Response('secret provider body', { status: 503 });
  } });
  const result = await p.decide(request(), async () => []);
  assert.equal(result.metrics.apiCalls, 1); assert.equal(result.metrics.modelCalls, 1);
  assert.equal(result.summary, undefined); assert.ok(!JSON.stringify(result).includes('secret provider body'));
});

test('real HTTP timeout and abort cancel pending fetches', async t => {
  const server = http.createServer((req, res) => { req.resume(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const p = new StoryPolicy(config({ baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 1000 }));
  const start = Date.now();
  assert.equal((await p.decide(request(), async () => [])).reason, 'model_timeout');
  assert.ok(Date.now() - start < 2500);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  assert.equal((await p.decide(request(), async () => [], controller.signal)).status, 'fallback');
});

test('bounded history includes actual actions, not stale integer choices', async () => {
  const p = new StoryPolicy(config(), { fetchImpl: async () => reply({ action: 0 }) });
  for (let step = 1; step <= 12; step++) await p.decide(request({ step }), async () => []);
  assert.equal(p.history.length, 10); assert.equal(p.history[0].step, 3);
  assert.equal(p.history[0].choice.label, '是');
});
