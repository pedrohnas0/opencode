# Phase 5 — Model & Agent Selection

**Goal:** Let users pick which AI model and agent to use per-chat via inline
keyboards. The SDK already supports per-prompt overrides (`session.prompt({
model, agent })`), so this phase adds the UI layer and per-chat state.

## What This Phase Delivers

1. **`/model` command** — Shows a two-step inline keyboard:
   first pick a provider, then pick a model from that provider.
   The selection is stored as a per-chat override applied to every subsequent prompt.

2. **`/agent` command** — Shows available agents (non-hidden) as an inline keyboard.
   Selecting one stores the override per-chat.

3. **Per-chat overrides in SessionEntry** — Optional `modelOverride` and
   `agentOverride` fields, passed to `sdk.session.prompt()` on every message.

4. **Reset buttons** — Both `/model` and `/agent` include a "Reset to default"
   button to clear the override.

## SDK Endpoints Used

```ts
// Fetch all providers with their models
sdk.provider.list()
// → { all: Provider[] }
// Each Provider: { id, name, models: { [modelID]: Model } }
// Each Model: { id, name, cost?, limit?, capabilities?, ... }

// Fetch all agents
sdk.app.agents()
// → Agent[]
// Each Agent: { name, description?, mode, hidden?, ... }

// Per-prompt override (existing — just need to pass the fields)
sdk.session.prompt({
  sessionID: string,
  parts: [...],
  model?: { providerID: string, modelID: string },  // ← override
  agent?: string,                                     // ← override
})
```

## Architecture

### Model Selection Flow

```
/model
  → sdk.provider.list()
  → Filter providers that have ≥1 model
  → Show provider keyboard (1 per row, max 8)
  → callback_data: "mdl:{providerID}"

User clicks provider
  → sdk.provider.list() (re-fetch for models)
  → Show model keyboard for that provider + "⬅ Back" button
  → callback_data: "mdl:{providerID}:{modelID}" or "mdl:back"

User clicks model
  → sessionManager.get(chatKey) → set modelOverride
  → editMessageText: "Model set to: {providerName} / {modelName}"

User clicks "⬅ Back"
  → Re-show provider list

User clicks "Reset to default"
  → Clear modelOverride from SessionEntry
  → editMessageText: "Model reset to default."
```

### Agent Selection Flow

```
/agent
  → sdk.app.agents()
  → Filter: not hidden
  → Show agent keyboard (1 per row) + "Reset to default" button
  → callback_data: "agt:{agentName}" or "agt:reset"

User clicks agent
  → sessionManager.get(chatKey) → set agentOverride
  → editMessageText: "Agent set to: {agentName}"

User clicks reset
  → Clear agentOverride from SessionEntry
  → editMessageText: "Agent reset to default."
```

### Override Passing in handleMessage

```
BEFORE:
  sdk.session.prompt({
    sessionID: entry.sessionId,
    parts: [{ type: "text", text }],
  })

AFTER:
  sdk.session.prompt({
    sessionID: entry.sessionId,
    parts: [{ type: "text", text }],
    ...(entry.modelOverride && { model: entry.modelOverride }),
    ...(entry.agentOverride && { agent: entry.agentOverride }),
  })
```

## Callback Data Design

```
Model callbacks:
  mdl:{providerID}                    → show models for provider
  mdl:{providerID}:{modelID}          → select model
  mdl:back                            → back to provider list
  mdl:reset                           → clear model override

  Examples:
    "mdl:anthropic"                              = 14 bytes ✓
    "mdl:anthropic:claude-sonnet-4-5-20250929"   = 43 bytes ✓
    "mdl:back"                                   = 8 bytes ✓
    "mdl:reset"                                  = 9 bytes ✓

  Worst case: "mdl:" + 20-char provider + ":" + 38-char model = 63 bytes ✓

Agent callbacks:
  agt:{agentName}                     → select agent
  agt:reset                           → clear agent override

  Examples:
    "agt:code"                                   = 8 bytes ✓
    "agt:reset"                                  = 9 bytes ✓
```

## SessionEntry Changes

```ts
export type SessionEntry = {
  sessionId: string
  directory: string
  createdAt: number
  lastAccessAt: number
  modelOverride?: { providerID: string; modelID: string }  // ← NEW
  agentOverride?: string                                     // ← NEW
}
```

## Grammy Middleware Stack (updated)

```
  1. allowlistMiddleware(config.allowedUsers)
  2. bot.command("start", ...)
  3. bot.command("new", ...)
  4. bot.command("list", ...)
  5. bot.command("rename", ...)
  6. bot.command("delete", ...)
  7. bot.command("info", ...)
  8. bot.command("history", ...)
  9. bot.command("summarize", ...)
  10. bot.command("model", ...)              ← NEW
  11. bot.command("agent", ...)              ← NEW
  12. bot.command("cancel", ...)
  13. bot.on("callback_query:data", ...)     ← Extended with mdl: and agt: prefixes
  14. bot.on("message:text", ...)            ← Modified (pass overrides to prompt)
```

## New Files

```
src/
  handlers/
    models.ts                    ← formatProviderList, formatModelList,
                                   parseModelCallback, formatCurrentModel,
                                   handleModel, handleModelSelect
    models.test.ts               ← ~18 tests
    agents.ts                    ← formatAgentList, parseAgentCallback,
                                   handleAgent, handleAgentSelect
    agents.test.ts               ← ~10 tests
e2e/
  phase-5.test.ts                ← 3 E2E tests
```

## Modified Files

```
src/
  session-manager.ts             ← Add modelOverride? and agentOverride? to SessionEntry
  session-manager.test.ts        ← 3 new tests for override fields
  bot.ts                         ← /model, /agent commands, mdl: + agt: callback routing,
                                   pass overrides in handleMessage prompt call
  bot.test.ts                    ← ~6 new tests (override passing, new commands)
  index.ts                       ← Add model/agent to setMyCommands
```

## TDD Execution Order (bottom-up by dependency)

### Group A — Foundational / Independent Pieces

#### A1. session-manager.ts — model/agent override fields (3 new tests)

Add optional fields to SessionEntry type. No logic changes needed — `set()`
already stores the full entry object and `get()` returns it.

Tests:
1. `set/get` with `modelOverride` preserves value
2. `set/get` with `agentOverride` preserves value
3. `getOrCreate` returns entry without overrides by default

#### A2. handlers/models.ts — model selection (18 tests)

Pure functions + thin async handlers.

**Pure functions:**

```ts
formatProviderList(providers: any[]): { text: string; reply_markup: any }
// → Inline keyboard: one row per provider, button text = provider name
// → callback_data = "mdl:{providerID}"
// → Last row: "Reset to default" button (mdl:reset) if override active

formatModelList(providerID: string, providerName: string, models: any[]): { text: string; reply_markup: any }
// → Inline keyboard: one row per model, button text = model name
// → callback_data = "mdl:{providerID}:{modelID}"
// → Last row: "⬅ Back" button (mdl:back)

parseModelCallback(data: string):
  | { type: "provider"; providerID: string }
  | { type: "model"; providerID: string; modelID: string }
  | { type: "back" }
  | { type: "reset" }
  | null

formatCurrentModel(override?: { providerID: string; modelID: string }): string
// → "Current model: {providerID}/{modelID}" or "Using default model"
```

**Async handlers:**

```ts
handleModel(params: { sdk, sessionManager, chatKey }):
  Promise<{ text: string; reply_markup: any }>
// → Fetches providers, prepends current model text, returns provider keyboard

handleModelSelect(params: { chatKey, providerID, modelID, sessionManager }):
  Promise<string>
// → Stores override in SessionEntry, returns confirmation text
```

Tests:
1. `parseModelCallback("mdl:anthropic")` → `{ type: "provider", providerID: "anthropic" }`
2. `parseModelCallback("mdl:anthropic:claude-sonnet")` → `{ type: "model", providerID: "anthropic", modelID: "claude-sonnet" }`
3. `parseModelCallback("mdl:back")` → `{ type: "back" }`
4. `parseModelCallback("mdl:reset")` → `{ type: "reset" }`
5. `parseModelCallback("invalid")` → `null`
6. `parseModelCallback("mdl:")` → `null` (empty after prefix)
7. `formatProviderList` with 2 providers → 2 button rows
8. `formatProviderList` with 0 providers → "No providers available."
9. `formatProviderList` filters providers with 0 models
10. `formatModelList` with 3 models → 3 button rows + back button
11. `formatModelList` with 0 models → "No models available." + back button
12. `formatModelList` callback_data includes providerID and modelID
13. `formatCurrentModel` with override → shows provider/model
14. `formatCurrentModel` without override → "Using default model"
15. `handleModel` fetches providers and returns keyboard
16. `handleModel` returns "No providers" when list is empty
17. `handleModelSelect` stores override in sessionManager
18. `handleModelSelect` returns confirmation message

#### A3. handlers/agents.ts — agent selection (10 tests)

**Pure functions:**

```ts
formatAgentList(agents: any[]): { text: string; reply_markup: any }
// → Inline keyboard: one row per agent (non-hidden), button text = name
// → callback_data = "agt:{name}"
// → Last row: "Reset to default" button (agt:reset)

parseAgentCallback(data: string):
  | { name: string }
  | { action: "reset" }
  | null
```

**Async handlers:**

```ts
handleAgent(params: { sdk, sessionManager, chatKey }):
  Promise<{ text: string; reply_markup: any }>

handleAgentSelect(params: { chatKey, agentName, sessionManager }):
  Promise<string>
```

Tests:
1. `parseAgentCallback("agt:code")` → `{ name: "code" }`
2. `parseAgentCallback("agt:reset")` → `{ action: "reset" }`
3. `parseAgentCallback("invalid")` → `null`
4. `parseAgentCallback("agt:")` → `null`
5. `formatAgentList` with 2 agents → 2 rows + reset row
6. `formatAgentList` filters hidden agents
7. `formatAgentList` with 0 agents → "No agents available."
8. `handleAgent` fetches agents and returns keyboard
9. `handleAgentSelect` stores override in sessionManager
10. `handleAgentSelect` returns confirmation message

### Group B — Wiring (bot.ts + index.ts)

#### B4. bot.ts — New commands, callback routing, override passing (6 new tests)

Changes:
- Add `/model` command → calls `handleModel`, replies with keyboard
- Add `/agent` command → calls `handleAgent`, replies with keyboard
- Add `mdl:` callback routing (provider select → show models, model select → store, back → providers, reset → clear)
- Add `agt:` callback routing (select → store, reset → clear)
- Modify `handleMessage` prompt call to spread `modelOverride` and `agentOverride`

New tests:
1. `handleMessage` passes `modelOverride` to `sdk.session.prompt` when set
2. `handleMessage` passes `agentOverride` to `sdk.session.prompt` when set
3. `handleMessage` passes no model/agent when overrides not set
4. `handleMessage` passes both overrides simultaneously
5. (integration covered by E2E for /model and /agent commands)

#### B5. index.ts — Command menu update

Add to `setMyCommands` array:
```ts
{ command: "model", description: "Select model" },
{ command: "agent", description: "Select agent" },
```

### Group C — E2E Tests

#### C6. E2E: phase-5.test.ts (3 tests) + full regression

```ts
describe("Phase 5 — Model & Agent Selection", () => {
  test("/model shows provider buttons", async () => {
    const reply = await sendAndWait(client, BOT, "/model", 15000)
    assertHasButtons(reply)
  }, 30000)

  test("/agent shows agent buttons", async () => {
    const reply = await sendAndWait(client, BOT, "/agent", 15000)
    assertHasButtons(reply)
  }, 30000)

  test("regression: text message still works", async () => {
    const reply = await sendAndWait(client, BOT, "Say hello", 60000)
    expect(reply.text.length).toBeGreaterThan(0)
  }, 90000)
})
```

Full regression: phases 0-5 E2E all pass.

## Edge Cases

### Model Selection
- Provider with 0 models → filtered out of list
- Model ID with colons in it → `parseModelCallback` splits on first two colons only
- `modelOverride` set but provider deleted from server → prompt fails gracefully (SDK error, not bot crash)
- User switches session via `/list` → override stays (it's per-chatKey, not per-session)

### Agent Selection
- Hidden agents → filtered out of keyboard
- Agent name with special chars → callback_data must be safe ASCII
- No agents configured → "No agents available."

### Override Persistence
- Overrides live in SessionManager (in-memory) → lost on bot restart
- This is acceptable: model/agent preference is lightweight, user re-selects if needed
- SessionEntry eviction (LRU/TTL) also clears overrides — consistent behavior

## Acceptance Criteria

- [ ] `/model` shows provider list with inline keyboard
- [ ] Selecting provider shows model list for that provider
- [ ] Selecting model stores override and shows confirmation
- [ ] "Reset to default" clears model override
- [ ] "⬅ Back" returns to provider list
- [ ] `/agent` shows agent list with inline keyboard
- [ ] Selecting agent stores override and shows confirmation
- [ ] "Reset to default" clears agent override
- [ ] Hidden agents excluded from list
- [ ] Next prompt uses selected model/agent override
- [ ] Overrides are per-chat (different chats have independent settings)
- [ ] Commands appear in Telegram "/" menu
- [ ] `bun test src/` passes (all unit tests)
- [ ] `bun test ./e2e/phase-5.test.ts` passes
- [ ] All Phase 0-4 E2E tests still pass (regression)

## Estimated Scope

- 2 new source files + 2 test files + 1 E2E test file
- ~200-250 LOC (src) + ~350-400 LOC (tests)
- Modified: session-manager.ts, session-manager.test.ts, bot.ts, bot.test.ts, index.ts

### Test Count Estimate

| File | New Tests |
|------|-----------|
| session-manager.test.ts | 3 |
| handlers/models.test.ts | 18 |
| handlers/agents.test.ts | 10 |
| bot.test.ts | 4 |
| **Unit total** | **~35 new → ~222 total** |
| E2E phase-5.test.ts | 3 |
| **E2E total** | **3 new → ~20 total** |
