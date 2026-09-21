import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDecision, decodeDecision, referencedCards, validSum, wire } from './decisions.mjs';

const packet = bytes => { const { msg, type } = decodeDecision(Buffer.from(bytes).toString('base64')); return buildDecision(msg, type); };
const i32 = n => { const b = Buffer.alloc(4); b.writeInt32LE(n); return [...b]; };
const card = (code, tail = 1) => [...i32(code), 1, 4, 0, tail];

test('native yes/no roundtrip and out-of-range/type rejection', () => {
  const d = packet([13, 1, ...i32(30)]);
  assert.equal(d.view.descriptionId, 30);
  assert.equal(d.encode({ action: 0 }).readInt32LE(), 1);
  for (const action of [-1, 2, 0.5, '0', null]) assert.throws(() => d.encode({ action }));
  assert.throws(() => packet([13, 1, 30]));
  assert.throws(() => packet([13, 1, ...i32(30), 0]));
});

test('native idle response uses per-category action indices', () => {
  const c = card(89631139).slice(0, 7);
  const d = packet([11, 1, 1, ...c, 0, 0, 0, 0, 1, ...c, ...i32(100), 1, 1, 0]);
  assert.deepEqual(d.view.actions.map(x => x.label), ['通常召唤', '发动效果', '进入战斗阶段', '结束回合']);
  assert.deepEqual(d.view.actions.map((_, action) => d.encode({ action }).readInt32LE()), [0, 5, 6, 7]);
});

test('forced chain cannot be declined or replaced by an optional trigger', () => {
  const d = packet([16, 1, 2, 0, ...i32(0), ...i32(0),
    0, 0, ...card(100), ...i32(1600), 0, 1, ...card(200), ...i32(3200)]);
  assert.equal(d.view.actions.length, 1);
  assert.equal(d.encode(d.automatic).readInt32LE(), 1);
});

test('card selection validates min/max, duplicates, ordering and cancel', () => {
  const d = packet([15, 1, 1, 1, 2, 3, ...card(1), ...card(2), ...card(3)]);
  assert.deepEqual([...d.encode({ indexes: [2, 0] })], [2, 2, 0]);
  assert.equal(d.encode({ cancel: true }).readInt32LE(), -1);
  for (const indexes of [[], [0, 0], [3], [0, 1, 2], ['0']]) assert.throws(() => d.encode({ indexes }));
  assert.equal(packet([15, 1, 1, 1, 1, 1, ...card(1)]).automatic, null, 'cancellation is also a legal choice');
});

test('tribute min is weight, max is cards', () => {
  const d = packet([20, 1, 0, 2, 2, 2, ...card(1, 2), ...card(2, 1)]);
  assert.deepEqual([...d.encode({ indexes: [0] })], [1, 0]);
  assert.throws(() => d.encode({ indexes: [1] }));
  assert.throws(() => d.encode({ cancel: true }));
});

test('sum validates mixed alternative values and mandatory placeholders', () => {
  const sumcard = (code, n) => [...card(code).slice(0, 7), ...i32(n)];
  const d = packet([23, 0, 1, ...i32(8), 1, 2, 1, ...sumcard(1, 3), 2, ...sumcard(2, 5), ...sumcard(3, 2)]);
  assert.deepEqual([...d.encode({ indexes: [0] })], [2, 0, 0]);
  assert.throws(() => d.encode({ indexes: [1] }));
  assert.equal(validSum([{ opParam: 2 | (4 << 16) }, { opParam: 3 | (6 << 16) }], 7, 0), true);
  assert.equal(validSum([{ opParam: 2 }, { opParam: 6 }], 6, 1), false);
  assert.equal(validSum([{ opParam: 3 }, { opParam: 4 }], 6, 1), true);
});

test('counter response validates distribution and encodes uint16 per candidate', () => {
  const d = packet([22, 1, 1, 0, 3, 0, 2, ...card(1).slice(0, 7), 2, 0, ...card(2).slice(0, 7), 4, 0]);
  assert.deepEqual([...d.encode({ counts: [1, 2] })], [1, 0, 2, 0]);
  for (const counts of [[3, 0], [1, 1], [1], [1, -2]]) assert.throws(() => d.encode({ counts }));
});

test('zone choice preserves wire controller and slot and validates count', () => {
  const d = packet([18, 1, 1, ...i32(~(1 | (1 << 17)))]);
  assert.deepEqual(d.view.candidates, [{ player: 1, location: 4, sequence: 0 }, { player: 0, location: 4, sequence: 1 }]);
  assert.deepEqual([...d.encode({ indexes: [1] })], [0, 4, 1]);
  assert.throws(() => d.encode({ indexes: [] }));
  // Native summon placement uses count 0 for a single zone.
  const implicitOne = packet([18, 1, 0, ...i32(~1)]);
  assert.deepEqual([...implicitOne.encode({ indexes: [0] })], [1, 4, 0]);
  assert.deepEqual(implicitOne.automatic, { indexes: [0] });
});

test('unselect allows reversible removal and engine finish flag', () => {
  const d = packet([26, 1, 1, 0, 1, 2, 1, ...card(1), 1, ...card(2)]);
  assert.equal(d.view.actions.length, 3);
  assert.deepEqual([...d.encode({ action: 1 })], [1, 1]);
  assert.equal(d.encode({ action: 2 }).readInt32LE(), -1);
});

test('declaring numbers encodes list index, not number; sort is a permutation', () => {
  const d = packet([143, 1, 2, ...i32(100), ...i32(300)]);
  assert.equal(d.encode({ action: 1 }).readInt32LE(), 1);
  const sort = packet([25, 1, 2, ...card(1).slice(0, 7), ...card(2).slice(0, 7)]);
  assert.deepEqual([...sort.encode({ indexes: [1, 0] })], [1, 0]);
  assert.throws(() => sort.encode({ indexes: [1, 1] }));
});

test('race and attribute bitmask selections are bounded without combinatorial enumeration', () => {
  const d = packet([140, 1, 2, ...i32(7)]);
  assert.equal(d.encode({ indexes: [0, 2] }).readInt32LE(), 5);
  assert.throws(() => d.encode({ indexes: [0] }));
  assert.equal(packet([141, 1, 1, ...i32(3)]).encode({ indexes: [1] }).readInt32LE(), 2);
});

test('unknown/card-declaration windows fall back instead of sending integer zero', () => {
  assert.throws(() => packet([142, 1, 0]), /unsupported/);
  assert.deepEqual(referencedCards({ code: 123, desc: 16000, other: { id: 234 } }), [123, 1000, 234]);
});
