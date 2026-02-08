# Phase 4 — Session Management + Hardening

**Goal:** Add session management commands, security allowlist, fix the streaming
interruption bug, restore sessions on restart, and register the command menu in Telegram.

## What This Phase Delivers

1. **Allowlist middleware (N1)** — `TELEGRAM_ALLOWED_USERS` env var restricts bot access
   to specific Telegram user IDs. Grammy middleware at the top silently ignores non-allowed users.

2. **Streaming interruption fix (N2)** — When a user sends a new message while the bot is
   still streaming a response, the old turn's SSE events were corrupting the new turn.
   Fix: abort the old prompt on the server + generation counter to ignore stale events.

3. **Session restore on restart (N3)** — On startup, call `sdk.session.list()` and
   pre-populate SessionManager with sessions matching `Telegram {chatId}` title pattern.

4. **Telegram command menu (N4)** — Register all commands via `bot.api.setMyCommands()`
   so they appear in Telegram's "/" autocomplete menu.

5. **`/list` command** — Show sessions with inline keyboard, click to switch.

6. **`/rename <title>` command** — Rename current session.

7. **`/delete` command** — Delete current session.

8. **`/info` command** — Show session info (title, created, updated, directory).

9. **`/history` command** — Show recent messages in current session.

10. **`/summarize` command** — Summarize current session.

## Architecture

### Allowlist Middleware

```
Grammy middleware stack:
  1. allowlistMiddleware(config.allowedUsers)    ← NEW (top of stack)
  2. bot.command("start", ...)
  3. bot.command("new", ...)
  4. bot.command("list", ...)                    ← NEW
  5. bot.command("rename", ...)                  ← NEW
  6. bot.command("delete", ...)                  ← NEW
  7. bot.command("info", ...)                    ← NEW
  8. bot.command("history", ...)                 ← NEW
  9. bot.command("summarize", ...)               ← NEW
  10. bot.command("cancel", ...)
  11. bot.on("callback_query:data", ...)         ← Extended with sess: prefix
  12. bot.on("message:text", ...)                ← Modified (abort old prompt)
```

### Streaming Interruption Fix

```
BEFORE (bug):
  User sends message A
    → turnManager.start() → abort old turn's draft
    → sdk.session.prompt(A) fires
    → SSE events from A start arriving
  User sends message B (while A still streaming)
    → turnManager.start() → abort turn A's draft
    → sdk.session.prompt(B) fires
    → SSE events from A continue arriving ← BUG
    → session.idle from A finalizes turn B prematurely

AFTER (fix):
  User sends message A
    → turnManager.start() → generation=1
    → sdk.session.prompt(A) fires
    → SSE events arrive, check generation=1 ✓
  User sends message B (while A still streaming)
    → sdk.session.abort(sessionId) ← NEW: stop server-side generation
    → turnManager.start() → generation=2
    → sdk.session.prompt(B) fires
    → Stale events from A arrive, check generation≠2 → IGNORED
    → Events from B arrive, check generation=2 ✓
```

### Session Restore Flow

```
Bot startup:
  1. initSdk()
  2. Create SessionManager
  3. sessionManager.restore(sdk)              ← NEW
     → sdk.session.list()
     → Filter: title matches "Telegram {chatId}"
     → For each match: sessionManager.set(chatId, { sessionId, directory })
     → Log: "Restored N sessions"
  4. Create bot, EventBus, etc.
  5. bot.api.setMyCommands([...])             ← NEW
  6. bot.start()
```

### Session Commands Flow

```
/list
  → sdk.session.list()
  → Filter: not archived, sort by updated desc, take 10
  → Format as inline keyboard (1 session per row)
  → callback_data: "sess:{sessionId prefix}" (fit 64 bytes)

/list callback (sess: prefix)
  → sdk.session.list() (re-fetch for full ID)
  → Find session by prefix match
  → sessionManager.set(chatKey, { sessionId, directory })
  → Edit message: "Switched to: {title}"

/rename <title>
  → sessionManager.get(chatKey)
  → sdk.session.update({ sessionID, title })
  → Reply: "Session renamed to: {title}"

/delete
  → sessionManager.get(chatKey)
  → sdk.session.delete({ sessionID })
  → sessionManager.remove(chatKey)
  → Reply: "Session deleted."

/info
  → sessionManager.get(chatKey) → sessionId
  → sdk.session.get({ sessionID })
  → Format: title, created, updated, directory, message count
  → Reply with formatted info

/history
  → sessionManager.get(chatKey) → sessionId
  → sdk.session.messages({ sessionID }) → paginated messages
  → Format: last 10 messages as "role: text" (truncated to fit)
  → Reply with formatted history

/summarize
  → sessionManager.get(chatKey) → sessionId
  → sdk.session.summarize({ sessionID })
  → Reply with summary text
```

## Callback Data Design (session switching)

```
Session buttons:
  sess:{sessionId prefix}       → 5 + 20 = 25 bytes ✓ (well under 64 bytes)

We use first 20 chars of sessionId as prefix.
On callback, re-fetch session.list() and find by startsWith(prefix).
```

## Config Changes

```ts
// config.ts — NEW field
export type Config = {
  botToken: string
  opencodeUrl: string
  projectDirectory: string
  testEnv: boolean
  allowedUsers: number[]          // ← NEW
  e2e: { apiId, apiHash, session, botUsername }
}

// Parsing:
// allowedUsers: (process.env.TELEGRAM_ALLOWED_USERS ?? "")
//   .split(",").map(s => s.trim()).filter(Boolean).map(Number).filter(n => !isNaN(n))
// Empty string / undefined → [] (accept all)
```

## ActiveTurn Changes

```ts
export type ActiveTurn = {
  sessionId: string
  chatId: number
  abortController: AbortController
  accumulatedText: string
  toolSuffix: string
  timers: Set<ReturnType<typeof setTimeout>>
  draft: { stop(): void; getMessageId(): number | null; update(text: string): Promise<void> } | null
  generation: number              // ← NEW: monotonic counter for stale event detection
}
```

## New Files

```
src/
  handlers/
    allowlist.ts                   ← Grammy middleware factory
    allowlist.test.ts              ← 6 tests
    sessions.ts                    ← handleList, handleRename, handleDelete,
                                     handleInfo, handleHistory, handleSummarize,
                                     parseSessionCallback, formatSessionList,
                                     formatSessionInfo, formatHistory
    sessions.test.ts               ← 24 tests
e2e/
  phase-4.test.ts                  ← 5 E2E tests
```

## Modified Files

```
src/
  config.ts                        ← Add allowedUsers field + parsing
  config.test.ts                   ← 3 new tests for allowedUsers parsing
  turn-manager.ts                  ← Add generation counter to ActiveTurn
  turn-manager.test.ts             ← 3 new tests for generation field
  session-manager.ts               ← Add restore() method
  session-manager.test.ts          ← 4 new tests for restore()
  bot.ts                           ← Allowlist middleware, new commands (/list, /rename,
                                     /delete, /info, /history, /summarize), sess: callback,
                                     abort old prompt before new turn, pass generation
  bot.test.ts                      ← Tests for new commands + abort behavior
  index.ts                         ← Session restore on startup, setMyCommands,
                                     generation check in onEvent handler
```

## TDD Execution Order (bottom-up by dependency)

### Group A — Foundational / Independent Pieces

#### 1. config.ts — allowedUsers field (3 new tests)

Modify existing pure function. Tests:

1. `TELEGRAM_ALLOWED_USERS="123,456"` → `allowedUsers: [123, 456]`
2. `TELEGRAM_ALLOWED_USERS=""` → `allowedUsers: []` (accept all)
3. `TELEGRAM_ALLOWED_USERS` undefined → `allowedUsers: []` (accept all)

#### 2. handlers/allowlist.ts — Allowlist middleware (6 tests)

Pure middleware factory, depends only on Config.allowedUsers.

```ts
// src/handlers/allowlist.ts
import type { MiddlewareFn, Context } from "grammy"

export function createAllowlistMiddleware(
  allowedUsers: number[],
): MiddlewareFn<Context> {
  // If empty list → allow all
  if (allowedUsers.length === 0) {
    return (ctx, next) => next()
  }
  const allowed = new Set(allowedUsers)
  return (ctx, next) => {
    const userId = ctx.from?.id
    if (!userId || !allowed.has(userId)) return // silently ignore
    return next()
  }
}
```

Tests:
1. Empty allowedUsers list → calls next() (allows all)
2. User ID in list → calls next()
3. User ID NOT in list → does not call next()
4. No `from` on context → does not call next()
5. Multiple users in list → all allowed
6. Non-numeric entries filtered out during config parsing (tested in config.test.ts)

#### 3. turn-manager.ts — Generation counter (3 new tests)

Add `generation` field to ActiveTurn, increment on each `start()`.

Changes:
- Add class-level `private generationCounter = 0`
- In `start()`: `this.generationCounter++`, assign to turn
- ActiveTurn gains `generation: number`

Tests:
1. First turn gets generation=1
2. Second turn (same session) gets generation=2
3. Different sessions get independent generations (counter is global, values are unique)

#### 4. session-manager.ts — restore() method (4 new tests)

```ts
async restore(sdk: OpencodeClient): Promise<number> {
  const result = await sdk.session.list()
  const sessions = result.data ?? []
  let restored = 0

  for (const session of sessions) {
    if (session.time?.archived) continue
    const match = session.title?.match(/^Telegram (\d+)$/)
    if (!match) continue

    const chatKey = match[1]
    // Only restore if not already mapped
    if (!this.get(chatKey)) {
      this.set(chatKey, {
        sessionId: session.id,
        directory: session.directory ?? "",
      })
      restored++
    }
  }

  return restored
}
```

Tests (with mock SDK):
1. Restores sessions with title "Telegram 12345" pattern
2. Ignores archived sessions
3. Ignores sessions without matching title pattern
4. Returns count of restored sessions
5. Does not overwrite existing mappings (if chatKey already present)

Wait — that's 5 tests, not 4. Let me recount: the "does not overwrite" case is important, so 5 tests.

#### 5. handlers/sessions.ts — Session command handlers (24 tests)

Pure functions + thin async handlers, depend on SDK types.

**Functions:**

```ts
// Formatting
formatSessionList(sessions: Session[]): { text: string; reply_markup: any }
formatSessionInfo(session: Session): string
formatHistory(messages: Message[]): string
parseSessionCallback(data: string): { sessionPrefix: string } | null

// Handlers (return string for reply, or { text, reply_markup } for keyboard)
handleList(params): Promise<{ text: string; reply_markup: any }>
handleRename(params): Promise<string>
handleDelete(params): Promise<string>
handleInfo(params): Promise<string>
handleHistory(params): Promise<string>
handleSummarize(params): Promise<string>
```

**Tests:**

*formatSessionList:*
1. Formats sessions as inline keyboard rows (title + date)
2. Filters out archived sessions
3. Sorts by updated desc
4. Limits to 10 sessions
5. Empty list returns "No sessions found." text

*parseSessionCallback:*
6. `parseSessionCallback("sess:abc123")` → `{ sessionPrefix: "abc123" }`
7. `parseSessionCallback("invalid")` → null

*handleList:*
8. Returns formatted session list from SDK
9. Returns "No sessions found." when list is empty

*handleRename:*
10. Returns "No active session." when no session mapped
11. Returns "Session renamed to: {title}" on success
12. Calls `sdk.session.update()` with correct params
13. Returns "Usage: /rename <title>" when title is empty

*handleDelete:*
14. Returns "No active session." when no session mapped
15. Returns "Session deleted." on success
16. Calls `sdk.session.delete()` then `sessionManager.remove()`

*handleInfo:*
17. Returns "No active session." when no session mapped
18. Returns formatted session info on success
19. Includes title, created date, updated date

*handleHistory:*
20. Returns "No active session." when no session mapped
21. Returns formatted message history
22. Truncates long messages
23. Returns "No messages yet." when history is empty

*handleSummarize:*
24. Returns "No active session." when no session mapped

### Group B — Wiring (bot.ts + index.ts)

#### 6. bot.ts — New commands, allowlist, abort (12 new tests)

Changes:
- Add `allowedUsers` to BotDeps (or accept from Config)
- Insert `createAllowlistMiddleware()` as first middleware
- Add commands: `/list`, `/rename`, `/delete`, `/info`, `/history`, `/summarize`
- Add `sess:` prefix handling in callback_query handler
- In `handleMessage()`: call `sdk.session.abort()` before `turnManager.start()` if existing turn
- Return `generation` on turn for index.ts to track

New tests:
1. Allowlist middleware blocks unauthorized user
2. Allowlist middleware allows authorized user
3. `/list` calls handleList and replies with keyboard
4. `/rename test` calls handleRename with title "test"
5. `/rename` without args returns usage message
6. `/delete` calls handleDelete
7. `/info` calls handleInfo
8. `/history` calls handleHistory
9. `/summarize` calls handleSummarize
10. `sess:` callback switches session
11. `handleMessage` calls `sdk.session.abort()` when existing turn present
12. `handleMessage` does NOT call abort when no existing turn

#### 7. index.ts — Session restore, command menu, generation check

Changes:
- Call `sessionManager.restore(sdk)` after creating managers
- Call `bot.api.setMyCommands([...])` before `bot.start()`
- In `onEvent` handler: streaming interruption fix (N2)

  **Streaming interruption defense layers:**

  1. **Primary: `sdk.session.abort()`** — In `handleMessage`, before starting a new turn,
     abort the old server-side prompt. The server stops emitting SSE events for the aborted prompt.

  2. **Secondary: `turnManager.start()` replaces old turn** — The old turn's draft is stopped,
     AbortController fires, timers cleared. The new turn takes over the sessionId slot.

  3. **Safety net: `finalizeResponse` empty-text guard** — If a stale `session.idle` somehow
     arrives and finds the new turn with empty `accumulatedText`, `finalizeResponse` returns
     early (no-op). However, `turnManager.end()` would still end the new turn prematurely.

  4. **Belt-and-suspenders: generation counter** — Each turn gets a monotonic `generation` number.
     The `session.idle` handler only finalizes if `turn.accumulatedText` is non-empty.
     With abort working correctly, layers 3-4 should never activate.

  **Decision:** `sdk.session.abort()` is the primary fix. Generation counter is metadata for
  debugging/logging. The empty-text guard in `finalizeResponse` catches the residual edge case.

No unit test for index.ts — validated by E2E.

Command menu registration:
```ts
await bot.api.setMyCommands([
  { command: "start", description: "Welcome message" },
  { command: "new", description: "New session" },
  { command: "cancel", description: "Stop generation" },
  { command: "list", description: "List sessions" },
  { command: "rename", description: "Rename session" },
  { command: "delete", description: "Delete session" },
  { command: "info", description: "Session info" },
  { command: "history", description: "Recent messages" },
  { command: "summarize", description: "Summarize session" },
])
```

### Group C — E2E Tests

#### 8. E2E: phase-4.test.ts (5 tests)

```ts
describe("Phase 4 — Session Management + Hardening", () => {
  test("/list shows sessions", async () => {
    // Send a message first to create a session
    await sendAndWait(client, BOT, "Say hello", 60000)
    // Then list
    const reply = await sendAndWait(client, BOT, "/list", 15000)
    // Should contain session info or "Select a session" or inline keyboard
    expect(reply.length).toBeGreaterThan(0)
  }, 90000)

  test("/info shows session details", async () => {
    const reply = await sendAndWait(client, BOT, "/info", 15000)
    // Should contain session info (title, dates)
    assertContains(reply, /session|title|created/i)
  }, 30000)

  test("/rename changes session title", async () => {
    const reply = await sendAndWait(client, BOT, "/rename Test Session", 15000)
    assertContains(reply, /renamed/i)
  }, 30000)

  test("regression: text message gets AI response", async () => {
    const reply = await sendAndWait(
      client, BOT,
      "Say exactly the word hello and nothing else",
      60000,
    )
    assertContains(reply, /hello/i)
  }, 90000)

  test("regression: /new creates fresh session", async () => {
    const reply = await sendAndWait(client, BOT, "/new", 15000)
    assertContains(reply, /session/i)
  }, 30000)
})
```

**Note:** `/delete` E2E test intentionally omitted — it would break subsequent tests by
removing the active session. `/history` and `/summarize` are hard to E2E test reliably
(depend on session content and server-side AI). They are covered by unit tests.

## Edge Cases

### Allowlist
- Empty `TELEGRAM_ALLOWED_USERS` → accept all (dev/testing mode)
- User sends message from group chat → `ctx.from.id` is the user, not the group
- Bot added to group → only allowed user IDs can interact
- Callback queries also filtered (middleware runs before all handlers)

### Streaming Interruption
- User sends 3 messages rapidly → only last one's turn survives
- `sdk.session.abort()` fails → turn still starts (log error, continue)
- Stale `session.idle` with empty `accumulatedText` → `finalizeResponse` returns early (no-op)

### Session Restore
- No sessions on server → restore returns 0, bot starts fresh
- Session titles don't match pattern → ignored (only "Telegram {chatId}" restored)
- Multiple sessions for same chatId → last one wins (sorted by server)
- Server unreachable during restore → log error, continue without restore
- **Known limitation:** Sessions renamed via `/rename` won't auto-restore (title no longer matches pattern). User can still switch manually via `/list`.

### Session Commands
- `/list` with no sessions → "No sessions found."
- `/list` with >10 sessions → only shows 10 most recent
- `/rename` without argument → "Usage: /rename <title>"
- `/delete` with no session → "No active session."
- `/info` with no session → "No active session."
- `/history` with no messages → "No messages yet."
- `/summarize` with no session → "No active session."
- `sess:` callback with deleted session → "Session not found."
- Session ID prefix collision (unlikely with 20 chars) → first match wins

### Command Menu
- `setMyCommands` failure → log error, bot still starts
- Commands registered globally (not per-chat)

## Acceptance Criteria

- [ ] `TELEGRAM_ALLOWED_USERS` env var restricts bot access
- [ ] Empty/undefined allowlist accepts all users
- [ ] Non-allowed users silently ignored (no error message)
- [ ] Sending new message while streaming aborts old generation
- [ ] Stale SSE events from aborted prompt don't corrupt new turn
- [ ] Bot restores sessions on restart (matching "Telegram {chatId}" pattern)
- [ ] Commands appear in Telegram "/" menu
- [ ] `/list` shows sessions with inline keyboard
- [ ] Clicking session button switches active session
- [ ] `/rename <title>` changes session title
- [ ] `/delete` removes session
- [ ] `/info` shows session details
- [ ] `/history` shows recent messages
- [ ] `/summarize` produces session summary
- [ ] `bun test src/` passes (all unit tests, ~180+)
- [ ] `bun test ./e2e/phase-4.test.ts` passes
- [ ] All Phase 0-3 E2E tests still pass (regression)

## Estimated Scope

- 2 new source files + 2 test files + 1 E2E test file
- ~350-450 LOC (src) + ~400-500 LOC (tests)
- Modified: config.ts, config.test.ts, turn-manager.ts, turn-manager.test.ts,
  session-manager.ts, session-manager.test.ts, bot.ts, bot.test.ts, index.ts

### Test Count Estimate

| File | New Tests |
|------|-----------|
| config.test.ts | 3 |
| handlers/allowlist.test.ts | 6 |
| turn-manager.test.ts | 3 |
| session-manager.test.ts | 5 |
| handlers/sessions.test.ts | 24 |
| bot.test.ts | 12 |
| **Unit total** | **~53 new → ~190 total** |
| E2E phase-4.test.ts | 5 |
| **E2E total** | **5 new → ~17 total** |
