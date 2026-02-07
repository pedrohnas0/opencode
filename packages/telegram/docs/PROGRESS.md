# OpenCode Telegram Bot — Progress Log

## Phase 0 — E2E Infrastructure + Bot Skeleton ✅

**Status:** Complete
**Date:** 2026-02-07

### Delivered
- Project scaffolding inside monorepo (`packages/telegram/`)
- Grammy bot with `/start` handler
- Config from env vars with validation
- Graceful shutdown (SIGINT/SIGTERM)
- E2E infrastructure: gramjs userbot client, test helpers, runner
- Session string generation script (`scripts/gen-session.ts`)

### Tests
| Type | Count | Status |
|------|-------|--------|
| Unit (bun test src/) | 12 | ✅ all pass |
| E2E (bun test ./e2e/phase-0.test.ts) | 2 | ✅ all pass |
| Manual (/start in Telegram) | 1 | ✅ working |

### Files Created
```
packages/telegram/
  package.json
  tsconfig.json
  bunfig.toml
  .env.example
  .env                          ← credentials (gitignored)
  .gitignore
  src/
    index.ts                    ← entry point
    bot.ts                      ← Grammy bot + /start
    bot.test.ts                 ← 4 tests
    config.ts                   ← env parsing
    config.test.ts              ← 8 tests
  e2e/
    client.ts                   ← gramjs wrapper
    helpers.ts                  ← sendAndWait, assertContains, clickInlineButton, etc.
    runner.ts                   ← setup/teardown (spawn bot + connect client)
    phase-0.test.ts             ← 2 E2E tests
  scripts/
    gen-session.ts              ← generate gramjs session string
```

### Lessons Learned
- `bunfig.toml`: `preload = []` is invalid, use `root = "./src"` instead
- Bun auto-loads `.env` — tests for default values need explicit `delete process.env.VAR`
- E2E runs in ~3s: gramjs connects, spawns bot, sends /start, verifies, tears down

---

## Phase 1 — Core Loop (MVP) ✅

**Status:** Complete
**Date:** 2026-02-07

### Delivered
- **SDK client factory** (`sdk.ts`): spawns local OpenCode server from monorepo source, or connects to external
- **SessionManager** (`session-manager.ts`): LRU-bounded map with TTL, reverse lookup (sessionId → chatKey)
- **TurnManager** (`turn-manager.ts`): per-turn AbortController + timer tracking, clean abort
- **EventBus** (`event-bus.ts`): single SSE connection, routes events to Telegram chats
- **Markdown formatter** (`send/format.ts`): Markdown → Telegram HTML conversion
- **Message chunker** (`send/chunker.ts`): split messages at 4096 char boundary
- **Message handler**: text → SessionManager → SDK prompt → EventBus → formatted response
- **`/new` command**: removes mapping, creates fresh session
- **index.ts wiring**: SDK init → bot + managers → EventBus → graceful shutdown

### Tests
| Type | Count | Status |
|------|-------|--------|
| Unit (bun test src/) | 76 | ✅ all pass |
| E2E Phase 0 (regression) | 2 | ✅ all pass |
| E2E Phase 1 | 3 | ✅ all pass |

### Files Created
```
src/
  sdk.ts                        ← SDK client factory (spawn or connect)
  session-manager.ts            ← LRU Map<chatKey, SessionEntry>
  session-manager.test.ts       ← 13 tests
  turn-manager.ts               ← Per-turn lifecycle (AbortController)
  turn-manager.test.ts          ← 12 tests
  event-bus.ts                  ← Single SSE connection + dispatcher
  event-bus.test.ts             ← 5 tests
  send/
    format.ts                   ← Markdown → Telegram HTML
    format.test.ts              ← 22 tests
    chunker.ts                  ← Split messages at 4096 chars
    chunker.test.ts             ← 8 tests
e2e/
  phase-1.test.ts               ← 3 E2E tests
```

### Files Modified
```
src/
  bot.ts                        ← Added message handler, /new command, BotDeps
  bot.test.ts                   ← Expanded to 8 tests (handleMessage, handleNew)
  index.ts                      ← Full wiring: SDK + managers + EventBus + shutdown
e2e/
  runner.ts                     ← Spawns server + bot separately, for-await stdout
  helpers.ts                    ← sendAndWait uses message ID ordering
  phase-0.test.ts               ← Increased beforeAll timeout for server startup
```

### Lessons Learned
- `Bun.spawn` stdout with `getReader()` + `Promise.race` timeout breaks stream reading — use `for await` instead
- `process.execPath` resolves bun correctly; ENOENT from spawn usually means CWD doesn't exist
- E2E runner must spawn OpenCode server separately (not nested inside bot) to avoid subprocess hang
- `sendAndWait` must use message ID ordering (not timestamps) to avoid picking up stale responses
- `createOpencode({ port: 0 })` from SDK needs the `opencode` binary — dev mode uses bun source directly

---

## Phase 2 — Interactive Controls 🔜

**Status:** Next up
**Plan:** See `docs/spec.md` Section 7
