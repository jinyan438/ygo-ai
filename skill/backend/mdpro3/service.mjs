#!/usr/bin/env node
// Private NDJSON stdio channel owned by one story duel. No listening port, MCP,
// shell tools, file browsing or game-control authority is exposed to the model.
import { StoryPolicy, validateConfig } from './policy.mjs';

let buffer = '', session, policy, busy = false, lastStep = 0, pendingCards;
const lifetime = new AbortController();
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const stop = () => { lifetime.abort(); pendingCards?.reject(new Error('closed')); process.exit(0); };
process.stdin.setEncoding('utf8');
process.stdin.on('end', stop); process.stdin.on('error', stop); process.stdout.on('error', stop);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
const startupTimer = setTimeout(stop, 15000);
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (buffer.length > 2 * 1024 * 1024) return stop();
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    let message; try { message = JSON.parse(line); } catch { return stop(); }
    receive(message).catch(stop);
  }
});

async function receive(message) {
  if (!message || message.version !== 1) return stop();
  if (!session) {
    if (message.type !== 'start' || typeof message.session !== 'string' || message.session.length > 64) return stop();
    session = message.session; clearTimeout(startupTimer);
    try { policy = new StoryPolicy(validateConfig(message.config)); }
    catch (e) { send({ type: 'ready', version: 1, session, status: 'error', reason: /^[a-z_]+$/.test(e.message) ? e.message : 'invalid_config' }); return stop(); }
    send({ type: 'ready', version: 1, session, status: 'ok' }); return;
  }
  if (message.session !== session) return stop();
  if (message.type === 'cards_result') {
    if (!pendingCards || message.step !== lastStep || !Array.isArray(message.cards)) return stop();
    const pending = pendingCards; pendingCards = null; clearTimeout(pending.timer);
    pending.resolve({ cards: message.cards, descriptions: message.descriptions || [] }); return;
  }
  if (message.type !== 'decision' || busy || !Number.isSafeInteger(message.step) || message.step <= lastStep) return stop();
  busy = true; lastStep = message.step;
  const result = await policy.decide(message, (ids, descriptions) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingCards = null; reject(new Error('cards_timeout')); }, 3000);
    pendingCards = { resolve, reject, timer };
    send({ type: 'cards', version: 1, session, step: lastStep, ids, descriptions });
  }), lifetime.signal, send);
  send(result); busy = false;
}
