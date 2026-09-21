#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { StoryPolicy, validateConfig } from './policy.mjs';

// Makes one small provider request; never prints credentials, provider error bodies or headers.
try {
  const configPath = path.resolve(process.argv[2] || '../plugins/story-ai.local.json');
  const input = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  const env = { ...process.env };
  const keyEnv = input.apiKeyEnv || 'STORY_AI_API_KEY';
  if (input.apiKeySource === 'file') env[keyEnv] = '';
  if (!env[keyEnv] && input.apiKeyFile) env[keyEnv] = fs.readFileSync(path.resolve(path.dirname(configPath), input.apiKeyFile), 'utf8').trim();
  const policy = new StoryPolicy(validateConfig(input, env));
  const started = Date.now();
  const result = await policy.decide({ session: 'probe', step: 1, hint: 0,
    packet: Buffer.from([13, 1, 30, 0, 0, 0]).toString('base64'),
    state: { botWirePlayer: 1, turn: 2, turnPlayer: 0, phase: 'Battle',
      situation: 'Attack replay: your 3000 ATK monster can directly attack the opponent, who has 2000 LP and no cards on the field. Continue the attack?' } }, async () => []);
  console.log(JSON.stringify({ model: input.model, status: result.status, source: result.source,
    reason: result.reason, elapsedMs: Date.now() - started, calls: policy.calls,
    response: result.response ? Buffer.from(result.response, 'base64').readInt32LE() : undefined }));
  process.exitCode = result.status === 'ok' && result.source === 'model' ? 0 : 1;
} catch (error) {
  console.error('Provider probe failed: ' + (/^[a-z_]+$/.test(error.message) ? error.message : 'check_local_config'));
  process.exitCode = 1;
}
