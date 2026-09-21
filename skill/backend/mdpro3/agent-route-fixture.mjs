#!/usr/bin/env node
// Test-only scripted endpoint. Validates the reference line against MDPro3's real
// core; it neither measures model strength nor replaces the live model policy.
import http from 'node:http';

const EARTH = 91188343, VENUS = 64734921, BALL = 39552864, NEPTUNE = 38529357;
const HALQ = 50588353, MOON = 90290572, APOLLO = 4280258;
const DIVINER = 92919429, TRIAS = 26866984, SECHSTE = 44163252, SIGRUN = 97854941, VFD = 88581108;
const route = { goal: '3素材2400攻击神弓，保留调整', route: [
  { action: '通常召唤并检索维纳斯', code: EARTH, targets: [VENUS] },
  { action: '发动并特召维纳斯', code: NEPTUNE, targets: [VENUS] },
  { action: '发动3次特召球体', code: VENUS, targets: [BALL] },
  { action: '连接召唤并拉厄斯', code: HALQ, targets: [EARTH, BALL] },
  { action: '连接召唤', code: MOON, targets: [BALL] },
  { action: '连接召唤', code: APOLLO, targets: [MOON, HALQ, VENUS] }
] };
const divinerRoute = { goal: '两素材法王兽，保留六女', route: [
  { action: '通常召唤并送墓三位圣统者', code: DIVINER, targets: [TRIAS] },
  { action: '解放神巫特殊召唤', code: TRIAS, targets: [DIVINER] },
  { action: '被解放效果拉六女', code: DIVINER, targets: [SECHSTE] },
  { action: '特殊召唤希格露恩', code: SECHSTE, targets: [SIGRUN] },
  { action: '超量召唤', code: VFD, targets: [TRIAS, SIGRUN] }
] };

function choose(input) {
  const { decision: d, state, context } = input;
  const field = state.players[0].monsters.filter(Boolean), source = context.source?.code;
  const has = code => field.some(c => c.code === code);
  const action = (label, code) => d.actions?.find(a => a.label === label && (code === undefined || (a.card || d.card)?.code === code));
  const submit = a => { if (!a) throw new Error('fixture_action_unavailable'); return { action: a.index }; };
  if (d.type === 11) {
    if (state.players[0].hand.some(c => c.code === DIVINER) || context.turnPlan?.goal === divinerRoute.goal) {
      const a = has(VFD) ? action('结束回合') : action('通常召唤', DIVINER) || action('特殊召唤', VFD);
      return { ...submit(a), plan: divinerRoute };
    }
    let a;
    if (has(APOLLO)) a = action('结束回合');
    else if (!has(VENUS)) a = action('通常召唤', EARTH) || action('发动效果', NEPTUNE);
    else if (!has(HALQ)) a = action('发动效果', VENUS) || action('特殊召唤', HALQ);
    else if (!has(MOON)) a = action('特殊召唤', MOON);
    else a = action('特殊召唤', APOLLO);
    return { ...submit(a), plan: route };
  }
  if (d.type === 16) return submit(d.actions.find(a => a.label === '发动连锁' && [EARTH, HALQ, DIVINER, SECHSTE, TRIAS].includes(a.card.code)) || action('不连锁'));
  if (d.type === 12) return submit(action([EARTH, HALQ, DIVINER, SECHSTE].includes(d.card.code) ? '发动效果' : '不发动'));
  if (d.type === 26) {
    const materials = { [HALQ]: [EARTH, BALL], [MOON]: [BALL, BALL], [APOLLO]: [MOON, HALQ, VENUS], [VFD]: [TRIAS, SIGRUN] }[source];
    if (!materials) throw new Error('fixture_unknown_summon');
    const selected = (d.selectedCards || []).map(c => c.code), remaining = [...materials];
    for (const code of selected) {
      const i = remaining.indexOf(code); if (i < 0) throw new Error('fixture_unexpected_material'); remaining.splice(i, 1);
    }
    return submit(remaining.length ? action('选择', remaining[0]) : action('完成选择'));
  }
  if ([18, 24].includes(d.type)) {
    const candidates = d.candidates.map((c, index) => ({ ...c, index }));
    candidates.sort((a, b) => (b.sequence >= 5) - (a.sequence >= 5));
    return { indexes: candidates.slice(0, d.constraints.min).map(c => c.index) };
  }
  if (d.type === 15) {
    if (source === VFD) return { indexes: d.candidates.map((c, i) => [TRIAS, SIGRUN].includes(c.code) ? i : -1).filter(i => i >= 0) };
    const target = { [EARTH]: VENUS, [NEPTUNE]: VENUS, [VENUS]: BALL, [HALQ]: EARTH,
      [DIVINER]: input.hint === 504 ? TRIAS : SECHSTE, [TRIAS]: DIVINER, [SECHSTE]: SIGRUN }[source];
    const index = d.candidates.findIndex(c => c.code === target);
    if (index < 0) throw new Error('fixture_target_unavailable');
    return { indexes: [index] };
  }
  if (d.type === 19) return submit(action('表侧守备') || action('表侧攻击'));
  if (d.type === 13) return submit(action('是'));
  throw new Error('fixture_unhandled_window');
}

const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1000000) { res.writeHead(413).end(); return; } }
  try {
    const request = JSON.parse(raw), input = JSON.parse(request.messages[1].content);
    const choice = choose(input);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(choice) } }] }));
  } catch (error) {
    console.error(error.message);
    res.writeHead(422).end();
  }
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
