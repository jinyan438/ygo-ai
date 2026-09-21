# MDPro3 story opponent

This directory provides the policy service used by the MDPro3 story plugin. It
requires Node 22+ and the repository's vendored `ygopro-msg-encode` dependency.
It does not require the external WindBot binary, MCP server, a second duel core,
or an npm install in an existing complete checkout.

The plugin starts `service.mjs` for each duel and owns its lifetime. Transport is
private NDJSON over stdio. Version 1 exchanges are:

1. `start {version,session,config}` -> `ready {version,session,status}`.
2. `decision {version,session,step,packet,state,hint}`, with the base64 core packet
   including its message byte, without the STOC byte.
3. When card text is needed: `cards {version,session,step,ids,descriptions}` ->
   `cards_result {version,session,step,cards,descriptions}`. System hints and effect
   descriptions are resolved by the client alongside card names and text.
4. Before each HTTP attempt: `progress {version,session,step,modelCalls}`. Counts
   include failed requests and repair attempts, but not automatic choices.
5. `result {version,session,step,status,source?,response?,reason?,summary?,metrics}`. Response is
   base64 engine response bytes. `fallback` has no response and leaves the
   original packet to the plugin's local WindBot executor.

`summary` is a bounded Chinese description derived from the actual selected
candidate and selection hint, not an unverified outcome claimed by the model.
Its short model-written comment is returned separately as `intention`; the UI
does not display it. Provider `reasoning_content` is never returned or recorded.
`metrics` reports `elapsedMs`, per-decision `apiCalls`, cumulative `modelCalls`,
`promptChars`, `completionTokens`, `reasoningTokens` (when available) and `planSteps`.
The plugin renders summaries and live statistics in the native right-side chat.

Session and strictly increasing step IDs prevent stale results. Only one decision
may be in flight. Frames, provider bodies, context, retries and per-duel request
counts are bounded. Owner EOF cancels pending work and exits. Service errors never
echo provider bodies or credentials.

`decisions.mjs` reuses the protocol decoder and adds strict validation, including
MDPro3's mandatory sum-selection placeholder bytes. It deliberately does not use
the simulator's unbounded combination enumeration. Card declaration and chain
sorting remain native fallback windows until their core-specific contracts are
verified. Do not replace an unsupported window with an arbitrary integer zero.

The model sees a fresh private-information-filtered state and engine candidates,
plus localized card text from the client, recent choices and an advisory plan.
It returns JSON indices; it does not encode engine bytes or decide match results.
The model has no tools, network browsing or filesystem access.

`strategy.mjs` keeps a structured goal/route across zones, positions and pass-chain
windows. The first proactive main/battle action must include an own-deck plan;
one bounded repair is allowed if it is missing. This checks shape and card IDs,
not the future legality of an entire combo. A turn change, negation or fallback
invalidates the plan. Effect-resolution sources, original/current card levels
and already-selected interactive materials accompany each fresh decision.
Agent/Fairy deck advice and specific tactical warnings help avoid wrong triggers,
wasting hand traps, premature endings and dismantling an existing interaction.
Interactive select/unselect windows return exactly one action, never a card array.

Official DeepSeek defaults to `thinkingMode: "adaptive"`: one low-effort planning
attempt per turn's first free-action window (6 seconds, 1536 tokens), followed by
fast selections (thinking disabled, 768 tokens). A timed-out or truncated planning
attempt can retry fast within the shared 12-second HTTP deadline. Format repair
and tactical reconsideration also share that deadline and the request budget.
Other modes are `disabled`, `enabled` and `provider` (omit the provider-specific
parameter, the default for other endpoints). Full candidates and card effects
are preserved; empty effect strings retain their original sparse indices.
HTTP 401/402/403 stop further provider attempts for the current duel.

```powershell
node --test skill/backend/mdpro3/*.test.mjs
node skill/backend/mdpro3/probe.mjs ../plugins/story-ai.local.json
```

The probe makes a real provider request. `fake-provider.mjs` is a local test server
used by `plugins/tools/story-model-test.ps1`, including an intentional HTTP 503.
`agent-route-fixture.mjs` is a separate test-only scripted endpoint for verifying
the Earth/Neptune/Venus/Halq/Moon/Apollousa and Diviner/Trias/Sechste/Sigrun/VFD
reference lines in the native duel core.
It never runs as a live policy and does not measure LLM playing strength.
Full configuration and game integration instructions are in `plugins/STORY-AI.md`
in the companion MDPro3-plugins repository.

`benchmark.mjs <config.json> <model-benchmark.json>` alternates three samples of
provider defaults and fast settings against the same live decision captured by
the isolated plugin self-test. It prints only sanitized timing/token statistics.
