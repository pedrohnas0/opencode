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

### How to Run

```bash
# From the telegram package directory:
cd packages/telegram

# Set OPENCODE_DIRECTORY to the project you want the AI to work on:
env $(grep -v '^#' .env | xargs) OPENCODE_DIRECTORY=/home/pedro/dev bun run src/index.ts

# Or connect to an existing OpenCode server:
env $(grep -v '^#' .env | xargs) OPENCODE_URL=http://127.0.0.1:4096 bun run src/index.ts
```

**How it works:**
- Without `OPENCODE_URL`: spawns a local OpenCode server from monorepo source (`packages/opencode`)
- The server CWD stays at `packages/opencode` (for module resolution)
- `OPENCODE_DIRECTORY` is sent as `x-opencode-directory` header in every SDK request
- The OpenCode server uses that header to know which project to operate on

### Lessons Learned
- `Bun.spawn` stdout with `getReader()` + `Promise.race` timeout breaks stream reading — use `for await` instead
- `process.execPath` resolves bun correctly; ENOENT from spawn usually means CWD doesn't exist
- E2E runner must spawn OpenCode server separately (not nested inside bot) to avoid subprocess hang
- `sendAndWait` must use message ID ordering (not timestamps) to avoid picking up stale responses
- `createOpencode({ port: 0 })` from SDK needs the `opencode` binary — dev mode uses bun source directly
- Server CWD must be `packages/opencode` (module resolution); project dir via `x-opencode-directory` header

---

## Phase 2 — Interactive Controls ✅

**Status:** Complete
**Date:** 2026-02-07

### Delivered
- **Permission handling** (`handlers/permissions.ts`): Inline keyboard (Allow / Always / Deny) on `permission.asked` SSE events. Callback routes to `sdk.permission.reply()`.
- **Question handling** (`handlers/questions.ts`): Inline keyboard with option buttons + Skip on `question.asked` SSE events. Callback routes to `sdk.question.reply()` or `sdk.question.reject()`.
- **PendingRequests** (`pending-requests.ts`): Bounded Map with TTL for request state tracking — enables index→label resolution for questions and double-click protection for both.
- **`/cancel` command** (`handlers/cancel.ts`): Aborts active turn via `sdk.session.abort()`, cleans up TurnManager.
- **Typing indicator** (`handlers/typing.ts`): Sends "typing" chat action every 4s during active turns, auto-stops on turn end via AbortSignal.
- **Callback query routing** in `bot.ts`: Routes `perm:` and `q:` prefixed callbacks, always calls `answerCallbackQuery()` first, edits original message to show decision.
- **EventBus wiring** in `index.ts`: Handles `permission.asked` and `question.asked` events, stores in PendingRequests, sends formatted messages with keyboards.

### Tests
| Type | Count | Status |
|------|-------|--------|
| Unit (bun test src/) | 108 | ✅ all pass |
| E2E Phase 0 (regression) | 2 | ✅ all pass |
| E2E Phase 1 (regression) | 3 | ✅ all pass |
| E2E Phase 2 | 3 | ✅ all pass |

### Files Created
```
src/
  pending-requests.ts              ← Bounded Map<requestID, PendingEntry> with TTL
  pending-requests.test.ts         ← 7 tests
  handlers/
    permissions.ts                 ← formatPermissionMessage(), parsePermissionCallback()
    permissions.test.ts            ← 8 tests
    questions.ts                   ← formatQuestionMessage(), parseQuestionCallback(), resolveQuestionAnswer()
    questions.test.ts              ← 8 tests
    cancel.ts                      ← handleCancel()
    cancel.test.ts                 ← 5 tests
    typing.ts                      ← startTypingLoop()
    typing.test.ts                 ← 4 tests
e2e/
  phase-2.test.ts                  ← 3 E2E tests (regression, /cancel, AI response)
```

### Files Modified
```
src/
  bot.ts                           ← Added /cancel, callback_query handler, BotDeps.pendingRequests,
                                      handleMessage returns { turn }, typing loop start
  bot.test.ts                      ← Updated tests for new return type
  index.ts                         ← PendingRequests instance, permission.asked + question.asked
                                      event handlers, periodic cleanup
e2e/
  helpers.ts                       ← Polling interval 500ms → 1500ms (flood wait mitigation)
  phase-0.test.ts                  ← Unknown command test adapted (bot now responds via AI)
```

### Key Design Decisions
- **No sessionID needed for permission/question SDK calls** — only requestID. Simplifies PendingRequests significantly.
- **Callback data fits 64-byte limit**: `perm:once:per_xxxx` (~40 bytes), `q:que_xxxx:0` (~35 bytes).
- **Single-select MVP for questions**: `multiple: true` and `custom: true` questions deferred.
- **E2E permission/cancel-during-generation tests deferred**: Timing-dependent on AI behavior and Grammy's sequential update processing.

### Lessons Learned
- Grammy processes updates sequentially — `/cancel` can't interrupt a handler blocked on `sdk.session.prompt()`
- `answerCallbackQuery()` MUST be called immediately in callback handlers (prevents Telegram loading spinner)
- E2E polling at 500ms triggers Telegram flood waits — 1500ms is safe
- Permission/question button E2E tests are inherently flaky (depend on AI triggering specific tool calls)
- Bot now processes unknown commands via AI (Phase 1 `message:text` handler catches them), so Phase 0 regression test needed updating

---

## Phase 3 — Streaming + UX 🔜

**Status:** Next up
**Plan:** See `docs/spec.md` Section 7
