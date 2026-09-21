#!/usr/bin/env node
// Deterministic local test endpoint. Fail request 2 to exercise in-duel fallback.
import http from 'node:http';
let calls = 0;
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1000000) { res.writeHead(413).end(); return; } }
  calls++;
  if (calls === 2) { res.writeHead(503).end(); return; }
  try {
    const request = JSON.parse(raw);
    const input = JSON.parse(request.messages[1].content);
    const d = input.decision; let choice;
    if (d.mode === 'action') {
      const priority = ['通常召唤', '特殊召唤', '攻击', '盖放魔陷', '盖放怪兽', '进入战斗阶段', '进入主要阶段2', '结束回合', '不发动', '不连锁'];
      const action = priority.map(label => d.actions.find(a => a.label === label)).find(Boolean) || d.actions[0];
      choice = { action: action.index };
    } else if (d.mode === 'indexes') {
      const min = d.constraints.min ?? 1;
      choice = { indexes: Array.from({ length: min }, (_, i) => i) };
    } else choice = { counts: d.candidates.map(() => 0) };
    choice.summary = '根据当前场面选择行动，保留后续进攻机会。';
    const ownCode = input.state.ownDeckComposition?.[0]?.code;
    if ([10, 11].includes(d.type) && ownCode) choice.plan = { goal: '测试协议选择', route: [
      { action: '测试当前合法选择', code: ownCode, targets: [] } ] };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(choice) } }] }));
  } catch { res.writeHead(400).end(); }
});
server.listen(Number(process.argv[2] || 0), '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(); });
