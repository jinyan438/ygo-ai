#!/usr/bin/env node
// Compare identical captured live decision windows. Print timing/token counts only.
import fs from 'node:fs';
import path from 'node:path';
import { StoryPolicy, validateConfig } from './policy.mjs';

try {
  const configPath = path.resolve(process.argv[2]);
  const input = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  const fixture = JSON.parse(fs.readFileSync(process.argv[3], 'utf8').replace(/^\uFEFF/, ''));
  const env = { ...process.env }, keyEnv = input.apiKeyEnv || 'STORY_AI_API_KEY';
  if (input.apiKeySource === 'file') env[keyEnv] = '';
  if (!env[keyEnv] && input.apiKeyFile) env[keyEnv] = fs.readFileSync(path.resolve(path.dirname(configPath), input.apiKeyFile), 'utf8').trim();
  for (let sample = 1; sample <= 3; sample++) {
    for (const mode of sample % 2 ? ['provider', 'disabled'] : ['disabled', 'provider']) {
      const policy = new StoryPolicy(validateConfig({ ...input, thinkingMode: mode,
        timeoutMs: mode === 'provider' ? 45000 : 12000, maxTokens: mode === 'provider' ? 4096 : 384 }, env));
      const result = await policy.decide({ session: 'benchmark', step: 1, packet: fixture.packet, state: fixture.state, hint: fixture.hint },
        async () => ({ cards: fixture.cards, descriptions: fixture.descriptions }));
      console.log(JSON.stringify({ sample, mode, model: input.model, status: result.status, reason: result.reason, ...result.metrics }));
    }
  }
} catch {
  console.error('Benchmark failed: check local config and isolated model-benchmark.json fixture.');
  process.exitCode = 1;
}
