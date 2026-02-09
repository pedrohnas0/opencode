# Phase 6.5 — Production Hardening + Bot Control API

**Goal:** Fix 3 critical production gaps (AUDIT.md), improve /model UX, and add
a Bot Control API so the AI can manage its own model/agent/session via skills.

## What This Phase Delivers

1. **EventBus auto-reconnect (G1/G5)** — SSE stream break → auto-reconnect
   with exponential backoff. Without this, the bot silently goes deaf.

2. **Grammy `apiThrottler()` middleware (G2)** — Automatic Telegram API 429
   rate limit handling.

3. **Grammy `sequentialize()` middleware (G3)** — Per-chat sequential update
   processing. Prevents race conditions with webhooks/runner.

4. **Smart /model filtering (G12)** — Only connected providers, most recent
   model per family, active model marked with ✓. Reduces 86 providers / ~400
   models → 4 providers / 16 models.

5. **Bot Control API** — Hono HTTP server (localhost:4097) that exposes bot
   state to the AI running in OpenCode. Enables AI-driven model switching,
   agent selection, and session management via skills.

6. **SKILL.md** — Teaches the AI how to use the Bot Control API to change
   models, agents, and sessions autonomously.

---

## Gap Details

### G1/G5 — EventBus auto-reconnect (CRITICAL)

**Current behavior:**
```ts
// event-bus.ts — stream ends → NOTHING HAPPENS. Bot goes deaf.
for await (const event of result.stream) { ... }
```

**Fix:** Reconnect loop with exponential backoff (2s→30s, 1.8x, ±25% jitter).

### G2 — apiThrottler() middleware

**Fix:** `bot.api.config.use(apiThrottler())` — Grammy queues + retries on 429.

**Dependency:** `@grammyjs/transformer-throttler`

### G3 — sequentialize() middleware

**Fix:** `bot.use(sequentialize((ctx) => String(ctx.chat?.id ?? "")))` — first
middleware, before allowlist.

**Dependency:** `@grammyjs/runner`

### G12 — Smart /model filtering

**Fix — 3 filters:**
1. Only show providers in `connected[]` (have API keys)
2. Group by `family`, keep most recent `release_date` per family
3. Mark active model with `✓` (from override or server default)

### Bot Control API

**Problem:** The AI runs in the OpenCode server but can't control the Telegram
bot's state (model override, agent override, session management). These live in
the bot's in-memory SessionManager — a separate process.

**Solution:** Hono HTTP server on `127.0.0.1:TELEGRAM_API_PORT` (default 4097).
The AI calls it via `curl` from bash. Follows the OpenCode server pattern
(`new Hono()` → `Bun.serve({ fetch: app.fetch })`).

**How the AI identifies itself:**
1. AI calls `curl localhost:4096/session` (OpenCode API)
2. Finds session with title `"Telegram {chatId}"`
3. Uses `sessionId` in Bot Control API calls
4. Bot does reverse lookup via `sessionManager.getBySessionId()` → chatKey

**Endpoints:**

| Method | Path | Body | Returns |
|--------|------|------|---------|
| `GET` | `/api/sessions` | — | All active sessions (chatId, sessionId, model, agent) |
| `GET` | `/api/session/:sessionId` | — | Session info (model, agent, turn status) |
| `POST` | `/api/session/:sessionId/model` | `{ providerID, modelID }` | Updated session |
| `POST` | `/api/session/:sessionId/agent` | `{ agent }` | Updated session |
| `POST` | `/api/session/:sessionId/new` | — | New session created |
| `GET` | `/api/models` | — | Connected providers + filtered models (JSON) |
| `GET` | `/api/agents` | — | Available agents (JSON) |

**Security:** Binds to `127.0.0.1` only — accessible from same VPS, no auth.

---

## Architecture

### EventBus reconnect loop

```
start()
  └→ reconnectLoop()
       └→ listen()
            └→ sdk.event.subscribe() → for await (stream)
                 ├→ event → onEvent(...)
                 └→ stream ends
       └→ if stopped: return
       └→ wait(backoff with jitter)
       └→ reconnectLoop() (retry)
```

**Backoff:** `delay = min(maxDelay, initialDelay * factor^attempt) * (1 + jitter * random(-1, 1))`

### Grammy middleware stack (updated)

```
1. apiThrottler()              ← NEW (API transformer)
2. sequentialize(chatId)       ← NEW (before all handlers)
3. allowlistMiddleware
4. bot.command("start", ...)
5. ... (all other handlers unchanged)
```

### Bot Control API (Hono pattern)

```
index.ts
  ├→ createBot(config, deps)           ← Grammy bot (existing)
  ├→ createApiServer(deps, port)       ← Hono API (NEW)
  └→ eventBus.start()                  ← SSE listener (existing)

createApiServer(deps)
  └→ new Hono()
       .get("/api/sessions", ...)
       .get("/api/session/:sessionId", ...)
       .post("/api/session/:sessionId/model", ...)
       .post("/api/session/:sessionId/agent", ...)
       .post("/api/session/:sessionId/new", ...)
       .get("/api/models", ...)
       .get("/api/agents", ...)
  └→ Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch })
```

Dependencies shared: `sessionManager`, `turnManager`, `sdk`.

---

## New Files

```
src/
  api-server.ts                ← Hono app + Bun.serve (Bot Control API)
  api-server.test.ts           ← Tests for all endpoints

deploy/
  skills/
    telegram-control/
      SKILL.md                 ← AI skill doc (copy to .opencode/skills/ on deploy)
```

## Modified Files

```
src/
  event-bus.ts                 ← Add reconnect loop with exponential backoff
  event-bus.test.ts            ← Tests for reconnect behavior
  bot.ts                       ← Add sequentialize() + pass connected/default to model handlers
  bot.test.ts                  ← Test middleware ordering
  config.ts                    ← Add apiPort config (TELEGRAM_API_PORT)
  config.test.ts               ← Test apiPort parsing
  index.ts                     ← Add apiThrottler() + start API server + shutdown
  handlers/models.ts           ← Add filterModels(), update format* signatures
  handlers/models.test.ts      ← Tests for filtering, connected, ✓ indicator
  package.json                 ← Add hono, @grammyjs/transformer-throttler, @grammyjs/runner
```

---

## TDD Execution Order

### A1. EventBus reconnect (8-10 tests)

**File:** `src/event-bus.ts` + `src/event-bus.test.ts`

Changes to EventBus:
- Add `reconnectLoop()` method that wraps `listen()` with retry logic
- Add backoff config: `initialDelayMs`, `maxDelayMs`, `backoffFactor`, `jitter`
- `start()` calls `reconnectLoop()` instead of `listen()` directly
- `stop()` sets `stopped = true` (already exists) — breaks reconnect loop
- Log reconnection attempts with attempt number and delay

**Tests:**

*Reconnect behavior:*
1. Reconnects after stream ends (mock stream that yields 2 events then closes)
2. Does NOT reconnect after stop() is called
3. Backoff delay increases on consecutive failures
4. Backoff delay resets to initial after successful connection
5. Jitter adds randomness to delay (delay varies between calls)
6. Max delay is capped at maxDelayMs

*Error handling:*
7. Reconnects after subscribe() throws an error
8. Reconnects after stream throws mid-iteration
9. Continues processing events after reconnecting (events from new stream arrive)

*Integration:*
10. stop() during reconnect delay cancels the reconnect

### B2. Grammy middleware — sequentialize + throttler (3-4 tests)

**File:** `src/bot.ts` + `src/bot.test.ts` + `src/index.ts`

Changes:
- `createBot()`: add `sequentialize()` as first middleware (before allowlist)
- `index.ts`: add `apiThrottler()` to `bot.api.config`

**Tests:**
1. Bot has sequentialize middleware (verify middleware count or behavior)
2. apiThrottler is configured on bot API (verify transformer count)
3. sequentialize key uses chat ID

### C3. Smart /model filtering (8-10 tests)

**File:** `src/handlers/models.ts` + `src/handlers/models.test.ts` + `src/bot.ts`

New function:
- `filterModels(models)` — groups by `family`, picks most recent `release_date`
  per family, excludes `status: "deprecated"`

Changes to existing functions:
- `formatProviderList(providers, connected?)` — filter by connected, show count
- `formatModelList(providerID, providerName, models, activeModelID?)` — ✓ marker
- `handleModel(params)` — pass `connected` and `default` from SDK response
- `bot.ts` callback — apply `filterModels`, pass `activeModelID`

**Tests:**

*filterModels:*
1. Groups by family, returns most recent per family
2. Excludes deprecated models
3. Keeps models without family field (uses id as key)
4. Handles single model per family (no-op)

*formatProviderList:*
5. Filters to only connected providers when connected array provided
6. Shows model count in button text
7. Shows all providers when connected not provided (backward compat)

*formatModelList:*
8. Marks active model with ✓ prefix
9. No ✓ when activeModelID not provided

*handleModel:*
10. Passes connected and default from SDK response

### D4. Bot Control API server (10-12 tests)

**File:** `src/api-server.ts` + `src/api-server.test.ts` + `src/config.ts`

New files:
- `api-server.ts` — Hono app with all endpoints + `createApiServer()` function
- `api-server.test.ts` — tests against the Hono app (no real Bun.serve needed,
  test via `app.request()` — Hono's built-in test utility)

Config change:
- `config.ts` — add `apiPort: number` (from `TELEGRAM_API_PORT`, default 4097)

Index change:
- `index.ts` — call `createApiServer()`, stop on shutdown

**Hono app design (following OpenCode pattern):**
```ts
import { Hono } from "hono"

export type ApiDeps = {
  sessionManager: SessionManager
  turnManager: TurnManager
  sdk: OpencodeClient
}

export function createApiApp(deps: ApiDeps) {
  return new Hono()
    .get("/api/sessions", (c) => { /* list active sessions */ })
    .get("/api/session/:sessionId", (c) => { /* session info */ })
    .post("/api/session/:sessionId/model", (c) => { /* set model */ })
    .post("/api/session/:sessionId/agent", (c) => { /* set agent */ })
    .post("/api/session/:sessionId/new", (c) => { /* new session */ })
    .get("/api/models", (c) => { /* connected + filtered */ })
    .get("/api/agents", (c) => { /* available agents */ })
}

export function createApiServer(deps: ApiDeps, port: number) {
  const app = createApiApp(deps)
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: app.fetch,
  })
}
```

**Tests (using `app.request()`):**

*Session endpoints:*
1. GET /api/sessions returns all active sessions with chatId, model, agent
2. GET /api/sessions returns empty array when no sessions
3. GET /api/session/:sessionId returns session info
4. GET /api/session/:sessionId returns 404 for unknown session

*Model/Agent override:*
5. POST /api/session/:sessionId/model sets modelOverride in SessionManager
6. POST /api/session/:sessionId/model returns 404 for unknown session
7. POST /api/session/:sessionId/agent sets agentOverride in SessionManager
8. POST /api/session/:sessionId/agent returns 404 for unknown session

*Session management:*
9. POST /api/session/:sessionId/new creates new session for the chat

*Provider/agent listing:*
10. GET /api/models returns connected providers with filtered models
11. GET /api/agents returns available agents
12. GET /api/models uses filterModels (reuses C3 logic)

### E5. SKILL.md — AI model/agent control skill

**File:** `deploy/skills/telegram-control/SKILL.md`

No tests — documentation only. Teaches the AI:
1. How to discover its own sessionId (curl OpenCode session list, match title)
2. Bot Control API base URL and endpoints
3. Workflow examples: "switch to Opus", "use a different agent", "start new chat"
4. Available models/agents listing

Deployment: copy to `$OPENCODE_DIRECTORY/.opencode/skills/telegram-control/SKILL.md`
on the VPS. Document in VPS.md.

### F6. E2E tests — phase-6.5 (6-8 tests)

**File:** `e2e/phase-6.5.test.ts`

New E2E tests validating the real Telegram + OpenCode + Bot API integration.
The E2E runner already has the bot process running (with API server on :4097).

**/model filtering (via Telegram userbot):**
1. /model shows provider buttons (not 86 — verify count is small, e.g. < 10)
2. Clicking a provider shows models (verify count is small per provider)

**Bot Control API (via curl from E2E test):**
3. GET /api/sessions returns at least 1 session after sending a message
4. POST /api/session/:id/model changes the model (GET confirms new value)
5. POST /api/session/:id/agent changes the agent (GET confirms new value)
6. POST /api/session/:id/new creates a new session (old sessionId differs)
7. GET /api/models returns providers with models (non-empty)
8. GET /api/agents returns agents (non-empty)

**How E2E tests call the Bot API:**
The E2E test process runs on the same machine as the bot. It can call
`fetch("http://127.0.0.1:4097/api/sessions")` directly — no Telegram
intermediary needed. This tests the real Hono server with real SessionManager.

**Flow for test 4 (model change):**
```
1. Userbot sends "hello" → bot creates session
2. E2E calls GET /api/sessions → find sessionId
3. E2E calls POST /api/session/:id/model { providerID, modelID }
4. E2E calls GET /api/session/:id → verify modelOverride changed
5. Userbot sends "ping" → bot responds (model override is used)
```

### G7. Full E2E regression

Run `bun test ./e2e/` — all previous 32 tests + new 6-8 tests must pass.

---

## Dependencies to Add

```json
{
  "dependencies": {
    "hono": "^4.x",
    "@grammyjs/transformer-throttler": "^1.x",
    "@grammyjs/runner": "^2.x"
  }
}
```

## Acceptance Criteria

- [ ] EventBus reconnects automatically after SSE stream breaks
- [ ] Reconnection uses exponential backoff (2s→30s)
- [ ] Bot continues working after OpenCode server restart
- [ ] Grammy apiThrottler handles 429 rate limits
- [ ] Grammy sequentialize prevents per-chat race conditions
- [ ] /model shows only connected providers (not all 86)
- [ ] /model shows only most recent model per family
- [ ] /model marks active model with ✓
- [ ] Bot Control API starts on configured port (default 4097)
- [ ] AI can list sessions via GET /api/sessions
- [ ] AI can change model via POST /api/session/:id/model
- [ ] AI can change agent via POST /api/session/:id/agent
- [ ] AI can create new session via POST /api/session/:id/new
- [ ] SKILL.md documents full workflow for AI
- [ ] E2E: /model shows filtered providers (small count, not 86)
- [ ] E2E: Bot Control API sessions, model, agent, new all work end-to-end
- [ ] `bun test src/` passes (all unit tests)
- [ ] `bun test ./e2e/` passes (all E2E tests, previous 32 + new ~7)

## Estimated Scope

- ~250-300 LOC new src (api-server.ts ~120, model filtering ~50, reconnect ~80)
- ~350-400 LOC new tests (unit + E2E)
- ~80 LOC SKILL.md
- 4 new files (api-server.ts, api-server.test.ts, e2e/phase-6.5.test.ts, SKILL.md)
- 3 new npm dependencies (hono, @grammyjs/transformer-throttler, @grammyjs/runner)

### Test Count Estimate

| File | New Tests |
|------|-----------|
| event-bus.test.ts | ~10 |
| bot.test.ts | ~3 |
| models.test.ts | ~10 |
| api-server.test.ts | ~12 |
| **Unit total** | **~35 new → ~287 total** |
| e2e/phase-6.5.test.ts | ~7 |
| **E2E total** | **~7 new → ~39 total** |
