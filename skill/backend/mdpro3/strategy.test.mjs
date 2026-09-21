import test from 'node:test';
import assert from 'node:assert/strict';
import { StrategyMemory, enrichDecision, tacticalWarning, describeChoice, deckAdvice, automaticTactic, normalizePlan } from './strategy.mjs';
import { StoryPolicy, validateConfig } from './policy.mjs';

const cards = [{ code: 91188343, name: '厄斯', level: 2, type: 0x1021, strings: ['检索'] },
  { code: 64734921, name: '维纳斯' }, { code: 38529357, name: '尼普顿' }, { code: 39552864, name: '球体' },
  { code: 90290572, name: '穆恩' }];
const state = () => ({ turn: 1, turnPlayer: 0, botWirePlayer: 1, chain: [], players: [
  { controller: 0, hand: [{ code: 91188343 }], monsters: [null, null, null, null, null, null, null], grave: [] },
  { controller: 1, monsters: [null, null, null, null, null, null, null] }], ownDeckComposition: cards.map(c => ({ code: c.code, count: 1 })) });
const normal = { type: 11, mode: 'action', actions: [{ index: 0, label: '通常召唤', card: { code: 91188343, controller: 1, location: 2, sequence: 0 } }] };
const plan = { goal: '维纳斯和球体转成额外怪兽', route: [
  { action: '通常召唤', code: 91188343, targets: [64734921] },
  { action: '发动效果', code: 38529357, targets: [64734921] } ] };

test('a turn route survives zones, positions, pass chains and absent plan fields', () => {
  const memory = new StrategyMemory(), s = state(); memory.observe(s, normal);
  memory.record(s, normal, { action: 0, plan }, cards, 'model');
  for (const type of [18, 19, 16]) {
    const view = { type, actions: [{ label: '不连锁' }] };
    memory.observe(s, view); memory.record(s, view, { action: 0 }, cards, 'automatic');
    assert.deepEqual(memory.plan, plan);
    assert.equal(memory.context(s, view, 0, cards).source.code, 91188343);
  }
  memory.observe(s, normal); memory.record(s, normal, { action: 0 }, cards, 'model');
  assert.deepEqual(memory.plan, plan);
  memory.observe({ ...s, turn: 2 }, normal); assert.equal(memory.plan, null); assert.equal(memory.pending, null);
});

test('resolution source uses one-based chain index and re-plans after a negation', () => {
  const memory = new StrategyMemory(), s = state(); memory.observe(s, normal);
  memory.record(s, normal, { action: 0, plan }, cards, 'model');
  s.chain = [{ code: 64734921, controller: 0 }]; s.solvingChainIndex = 1;
  assert.equal(memory.context(s, { type: 15 }, 509, cards).source.name, '维纳斯');
  assert.equal(memory.context(s, { type: 15 }, 509, cards).window, 'resolving_effect');
  memory.observe({ ...s, negatedChains: [1] }, { type: 15 }); assert.equal(memory.plan, null); assert.equal(memory.needsPlan, true);
});

test('candidate enrichment distinguishes wire seats and preserves real effect and current level', () => {
  const s = state(); s.players[0].hand[0] = { code: 91188343, level: 6, attack: 1000 };
  const raw = { ...normal, actions: [{ ...normal.actions[0], card: { ...normal.actions[0].card, desc: 91188343 * 16 } }] };
  const view = enrichDecision(raw, s, cards, [{ descriptionId: 91188343 * 16, text: '真实效果提示' }]);
  const card = view.actions[0].card;
  assert.equal(card.side, 'self'); assert.equal(card.originalLevel, 2); assert.equal(card.currentLevel, 6); assert.equal(card.effectText, '真实效果提示');
  assert.equal(describeChoice(view, { action: 0 }, {}), '通常召唤 厄斯 （手牌）');
  assert.equal(raw.actions[0].card.name, undefined, 'raw encoder candidates stay untouched');
});

test('detect wasted Maxx C, wrong Earth trigger and premature Agent turn ending', () => {
  const s = state(), memory = new StrategyMemory();
  const chain = { type: 16, actions: [{ label: '发动连锁', card: { code: 23434538 } }] };
  assert.ok(tacticalWarning(chain, { action: 0 }, s, {}));
  assert.equal(tacticalWarning(chain, { action: 0 }, { ...s, turnPlayer: 1 }, {}), '');
  assert.equal(tacticalWarning(chain, { action: 0 }, { ...s, chain: [{ controller: 1 }] }, {}), '');
  const earth = { type: 11, actions: [...normal.actions, { label: '发动效果', card: { code: 38529357 } }] };
  assert.ok(tacticalWarning(earth, { action: 1 }, s, {}));
  s.players[0].monsters[0] = { code: 39552864 };
  const end = { type: 11, actions: [{ label: '结束回合' }, { label: '特殊召唤', card: { code: 90290572, location: 64 } }] };
  assert.ok(tacticalWarning(end, { action: 0 }, s, memory.context(s, end, 0, cards)));
  assert.deepEqual(deckAdvice({ ownDeckComposition: [{ code: 91188343 }] }), []);
});

test('automatic Maxx C hold never swallows a forced or other actionable chain', () => {
  const s = state(), g = { index: 0, label: '发动连锁', card: { code: 23434538 } }, pass = { index: 1, label: '不连锁' };
  assert.deepEqual(automaticTactic({ type: 16, actions: [g, pass] }, s), { action: 1 });
  for (const value of [{ ...s, turnPlayer: 1 }, { ...s, chain: [{ controller: 1 }] }, { ...s, lastSummonPlayer: 1 }])
    assert.equal(automaticTactic({ type: 16, actions: [g, pass] }, value), null);
  assert.equal(automaticTactic({ type: 16, actions: [g] }, s), null);
  assert.equal(automaticTactic({ type: 16, actions: [g, pass, { ...g, card: { code: 123 } }] }, s), null);
});

const idlePacket = Buffer.from([11, 1, 1, 71, 111, 111, 5, 1, 2, 0, 0, 0, 0, 0, 0, 0, 1, 0]).toString('base64');
const config = extra => validateConfig({ baseUrl: 'http://127.0.0.1:1234', model: 'test', allowAnonymousLocal: true,
  thinkingMode: 'adaptive', timeoutMs: 2000, strategyTimeoutMs: 500, ...extra }, {});
const reply = value => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));

test('adaptive planning is limited to one main-window attempt and followups stay fast', async () => {
  const modes = [], policy = new StoryPolicy(config(), { fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); modes.push(body.thinking.type);
    if (modes.length === 1) assert.equal(body.reasoning_effort, 'low');
    return reply({ action: 0, plan });
  } });
  const s = state();
  for (const [step, packet] of [[1, idlePacket], [2, Buffer.from([13, 1, 30, 0, 0, 0]).toString('base64')], [3, idlePacket]]) {
    const result = await policy.decide({ session: 'test', step, state: s, packet }, async () => cards);
    assert.equal(result.status, 'ok');
  }
  assert.deepEqual(modes, ['enabled', 'disabled', 'disabled']);
  assert.deepEqual(policy.strategy.plan, plan);
});

test('planning timeout cancels that request and spends remaining deadline on a fast selection', async t => {
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  const modes = [], policy = new StoryPolicy(config(), { fetchImpl: async (url, options) => {
    const mode = JSON.parse(options.body).thinking.type; modes.push(mode);
    if (mode === 'enabled') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    return reply({ action: 0, plan });
  } });
  const result = await policy.decide({ session: 'test', step: 1, state: state(), packet: idlePacket }, async () => cards);
  assert.equal(result.status, 'ok'); assert.deepEqual(modes, ['enabled', 'disabled']);
  assert.equal(result.metrics.apiCalls, 2); assert.ok(result.metrics.elapsedMs < 1900);
});

test('a first strategic action must include an own-deck plan and gets one bounded repair', async () => {
  const s = state(); let calls = 0;
  const p = new StoryPolicy(config({ thinkingMode: 'disabled' }), { fetchImpl: async () => reply(++calls === 1 ? { action: 0 } : { action: 0, plan }) });
  const result = await p.decide({ state: s, packet: idlePacket }, async () => cards);
  assert.equal(result.status, 'ok'); assert.equal(result.metrics.planSteps, 2); assert.equal(calls, 2);
  assert.equal(normalizePlan({ ...plan, route: [{ action: 'summon', code: 99999999, targets: [] }] }, s, cards), null);
  const bad = new StoryPolicy(config({ thinkingMode: 'disabled' }), { fetchImpl: async () => reply({ action: 0 }) });
  assert.equal((await bad.decide({ state: s, packet: idlePacket }, async () => cards)).status, 'fallback');
  assert.equal(bad.calls, 2);
});

test('protect an existing live boss from being spent on an intermediate link', () => {
  const s = state(); s.players[0].monsters[0] = { code: 4280258, sequence: 0, position: 1, attack: 2400 };
  const view = { type: 26, actions: [{ label: '选择', card: { code: 4280258, sequence: 0 } }] };
  assert.ok(tacticalWarning(view, { action: 0 }, s, { source: { code: 50588353 } }));
  assert.equal(tacticalWarning(view, { action: 0 }, s, { source: { code: 86066372 } }), '');
  s.players[0].monsters[0].attack = 0;
  assert.equal(tacticalWarning(view, { action: 0 }, s, { source: { code: 50588353 } }), '');
});

test('chat labels follow the actual selection hint without claiming resolution', () => {
  const view = { type: 15, candidates: [{ code: 64734921, name: '维纳斯', location: 1 }] };
  assert.equal(describeChoice(view, { indexes: [0] }, { source: { name: '厄斯' }, selectionHint: 506 }), '厄斯 / 选择加入手牌：维纳斯（卡组）');
  assert.equal(describeChoice(view, { indexes: [0] }, { selectionHint: 504 }), '选择送墓：维纳斯（卡组）');
});
