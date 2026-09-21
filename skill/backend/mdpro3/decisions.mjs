// MDPro3 uses the legacy byte-count protocol, including per-entry forced chains.
// Decoding is shared with ygo-ai; validation here is deliberately stricter than
// prepareResponse(), which encodes several invalid selections without rejecting them.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { requireSkillDependency } = require('../../runtime/src/vendor-require.cjs');
export const wire = requireSkillDependency('ygopro-msg-encode');
const ix = index => ({ index });
const int = n => { const b = Buffer.alloc(4); b.writeInt32LE(n | 0); return b; };
const ensure = (ok, why = 'invalid_selection') => { if (!ok) throw new Error(why); };

export function decodeDecision(payload) {
  ensure(typeof payload === 'string' && payload.length <= 90000, 'invalid_packet');
  const raw = Buffer.from(payload, 'base64');
  ensure(raw.length > 1 && raw.length <= 65535, 'invalid_packet');
  const msg = wire.YGOProMessages.getInstanceFromPayload(raw);
  ensure(msg && typeof msg.prepareResponse === 'function', 'unsupported_decision');
  // Reject truncated packets, unexpected trailing bytes and a different wire version.
  ensure(Buffer.from(msg.toPayload()).equals(raw), 'protocol_mismatch');
  return { msg, type: raw[0] };
}

function indexes(value, available, min, max) {
  ensure(Array.isArray(value) && value.length >= min && value.length <= max);
  ensure(value.every(x => Number.isInteger(x) && x >= 0 && x < available));
  ensure(new Set(value).size === value.length);
  return value;
}

export function buildDecision(msg, type) {
  const actions = [];
  const add = (label, response, detail = {}) => actions.push({ label, ...detail, response: Buffer.from(response) });
  const command = (cards, code, label) => (cards || []).forEach((card, i) => add(label, int((i << 16) | code), { card }));
  const view = { type, message: msg.constructor.name, player: msg.player };
  let encode;
  switch (type) {
    case 11:
      ['summonableCards', 'spSummonableCards', 'reposableCards', 'msetableCards', 'ssetableCards', 'activatableCards']
        .forEach((key, i) => command(msg[key], i, ['通常召唤', '特殊召唤', '改变表示', '盖放怪兽', '盖放魔陷', '发动效果'][i]));
      if (msg.canBp) add('进入战斗阶段', int(6));
      if (msg.canEp) add('结束回合', int(7));
      // Shuffling one's hand has no game effect and needlessly creates loops.
      break;
    case 10:
      command(msg.activatableCards, 0, '发动效果'); command(msg.attackableCards, 1, '攻击');
      if (msg.canM2) add('进入主要阶段2', int(2));
      if (msg.canEp) add('结束回合', int(3));
      break;
    case 16: {
      const forced = msg.chains.some(c => c.forced);
      msg.chains.forEach((card, i) => { if (!forced || card.forced) add('发动连锁', int(i), { card }); });
      if (!forced) add('不连锁', int(-1));
      view.hints = [msg.hint0, msg.hint1]; break;
    }
    case 12: view.card = { code: msg.code, controller: msg.controller, location: msg.location, sequence: msg.sequence, desc: msg.desc };
      add('发动效果', int(1)); add('不发动', int(0)); break;
    case 13: view.descriptionId = msg.desc; add('是', int(1)); add('否', int(0)); break;
    case 14: msg.options.forEach((descriptionId, i) => add('选择选项', int(i), { descriptionId })); break;
    case 19: view.code = msg.code;
      [1, 2, 4, 8].forEach((p, i) => { if (msg.positions & p) add(['表侧攻击', '里侧攻击', '表侧守备', '里侧守备'][i], int(p)); }); break;
    case 143: msg.numbers.forEach((number, i) => add('宣告数字', int(i), { number })); break;
    case 132: [1, 2, 3].forEach(n => add(['', '剪刀', '石头', '布'][n], int(n))); break;
    case 26:
      ensure(msg.selectableCards.length + msg.unselectableCards.length <= 256, 'protocol_mismatch');
      msg.selectableCards.forEach((card, i) => add('选择', Buffer.from([1, i]), { card }));
      msg.unselectableCards.forEach((card, i) => add('取消此卡', Buffer.from([1, msg.selectableCards.length + i]), { card }));
      if (msg.finishable || msg.cancelable) add(msg.finishable ? '完成选择' : '取消选择流程', int(-1));
      view.constraints = { totalMin: msg.min, totalMax: msg.max, finishable: !!msg.finishable,
        cancelable: !!msg.cancelable, response: 'Exactly one action index per message. Choose one card, remove one selected card, or finish/cancel if offered. Never return indexes here.' };
      view.selectedCards = msg.unselectableCards; break;
    case 15: case 20: {
      view.candidates = msg.cards; view.mode = 'indexes';
      view.constraints = type === 15
        ? { min: msg.min, max: msg.max, cancelable: !!msg.cancelable, ordered: true }
        : { minTributeValue: msg.min, maxCards: msg.max, cancelable: !!msg.cancelable, weightField: 'releaseParam' };
      encode = choice => {
        if (choice.cancel === true) { ensure(!!msg.cancelable); return int(-1); }
        const chosen = indexes(choice.indexes, msg.cards.length, type === 15 ? msg.min : 1, msg.max);
        if (type === 20) ensure(chosen.reduce((sum, i) => sum + msg.cards[i].releaseParam, 0) >= msg.min);
        return Buffer.from([chosen.length, ...chosen]);
      }; break;
    }
    case 18: case 24: {
      const places = msg.getSelectablePlaces();
      const count = Math.max(1, msg.count);
      view.candidates = places; view.mode = 'indexes';
      view.constraints = { min: count, max: count };
      encode = choice => msg.prepareResponse(indexes(choice.indexes, places.length, count, count).map(i => places[i])); break;
    }
    case 140: case 141: {
      const available = type === 140 ? msg.availableRaces : msg.availableAttributes;
      const bits = Array.from({ length: type === 140 ? 26 : 7 }, (_, i) => 1 << i).filter(bit => available & bit);
      view.mode = 'indexes'; view.candidates = bits; view.constraints = { min: msg.count, max: msg.count };
      encode = choice => int(indexes(choice.indexes, bits.length, msg.count, msg.count).reduce((a, i) => a | bits[i], 0)); break;
    }
    case 22:
      view.mode = 'counts'; view.candidates = msg.cards; view.constraints = { total: msg.counterCount, type: msg.counterType };
      encode = choice => {
        const counts = choice.counts;
        ensure(Array.isArray(counts) && counts.length === msg.cards.length);
        ensure(counts.every((n, i) => Number.isInteger(n) && n >= 0 && n <= msg.cards[i].counterCount));
        ensure(counts.reduce((a, n) => a + n, 0) === msg.counterCount);
        const b = Buffer.alloc(counts.length * 2); counts.forEach((n, i) => b.writeUInt16LE(n, 2 * i)); return b;
      }; break;
    case 23:
      view.mode = 'indexes'; view.candidates = msg.cards; view.mandatory = msg.mustSelectCards;
      view.constraints = { min: msg.min, max: msg.max || msg.cards.length, target: msg.sumVal, exact: msg.mode === 0, valueField: 'opParam' };
      encode = choice => {
        const chosen = indexes(choice.indexes, msg.cards.length, msg.min, msg.max || msg.cards.length);
        ensure(msg.mustSelectCards.length + chosen.length <= 255);
        ensure(validSum([...msg.mustSelectCards, ...chosen.map(i => msg.cards[i])], msg.sumVal, msg.mode, msg.mustSelectCards.length));
        // The vendored encoder omits the mandatory placeholder bytes. MDPro3 needs them.
        return Buffer.from([msg.mustSelectCards.length + chosen.length, ...msg.mustSelectCards.map(() => 0), ...chosen]);
      }; break;
    case 25: case 21:
      view.mode = 'indexes'; view.candidates = msg.cards;
      view.constraints = { min: msg.cards.length, max: msg.cards.length, ordered: true, meaning: 'For each original candidate, supply its new rank (0 is first).' };
      encode = choice => Buffer.from(indexes(choice.indexes, msg.cards.length, msg.cards.length, msg.cards.length)); break;
    // Card declaration requires querying the entire card database and evaluating
    // core-specific opcode programs. Until that contract is verified, use WindBot.
    default: throw new Error('unsupported_decision');
  }
  if (!encode) {
    ensure(actions.length > 0 && actions.length <= 2048, 'no_actions');
    view.mode = 'action'; view.actions = actions.map(({ response, ...a }, index) => ({ index, ...a }));
    encode = choice => { ensure(Number.isInteger(choice.action) && choice.action >= 0 && choice.action < actions.length); return actions[choice.action].response; };
  }
  let automatic = actions.length === 1 ? { action: 0 } : null;
  if (view.mode === 'indexes' && !view.constraints.cancelable && view.candidates.length === 1
    && view.constraints.min === 1 && view.constraints.max === 1)
    automatic = { indexes: [0] };
  // Even forced-looking sum selections need validation before bypassing the model.
  if (automatic) { try { encode(automatic); } catch { automatic = null; } }
  return { view, encode, automatic };
}

function values(card) {
  const p = card.opParam >>> 0;
  if (p & 0x80000000) return [p & 0x7fffffff];
  return [...new Set([p & 0xffff, p >>> 16].filter(x => x > 0))];
}

export function validSum(cards, target, mode, mandatoryCount = 0) {
  if (mode !== 0 && mode !== 1) return false;
  if (mode === 1) {
    // Greater-or-equal selections must be minimal: no optional card is redundant.
    const mins = cards.map(c => Math.min(...values(c)));
    const maxs = cards.map(c => Math.max(...values(c)));
    const lower = mins.reduce((a, n) => a + n, 0);
    return maxs.reduce((a, n) => a + n, 0) >= target && mins.slice(mandatoryCount).every(n => lower - n < target);
  }
  let sums = new Set([0]);
  for (const card of cards) {
    const next = new Set();
    for (const sum of sums) for (const n of values(card)) if (sum + n <= target) next.add(sum + n);
    ensure(next.size <= 20000, 'selection_too_complex'); sums = next;
  }
  return sums.has(target);
}

export function referencedCards(...objects) {
  const ids = new Set();
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['code', 'id'].includes(key) && Number.isInteger(child) && child > 0) ids.add(child & 0x7fffffff);
      else if (['desc', 'descriptionId'].includes(key) && Number.isInteger(child) && child >= 10000) ids.add(child >>> 4);
      else if (typeof child === 'object') walk(child);
    }
  };
  objects.forEach(walk); ensure(ids.size <= 2048, 'too_many_cards'); return [...ids];
}

export function referencedDescriptions(view, hint) {
  const ids = new Set(Number.isInteger(hint) && hint > 0 ? [hint] : []);
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['desc', 'descriptionId'].includes(key) && Number.isInteger(child) && child > 0) ids.add(child);
      else if (typeof child === 'object') walk(child);
    }
  };
  walk(view); return [...ids];
}
