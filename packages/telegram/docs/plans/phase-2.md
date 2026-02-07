# Phase 2 — Interactive Controls

**Goal:** Handle permissions, questions, and abort — without these the AI agent gets stuck
waiting for user input and the bot appears frozen.

## What This Phase Delivers

1. **Permission handling** — When `permission.asked` SSE event arrives, show inline buttons
   (Allow / Always / Deny). When clicked, call `sdk.permission.reply()`.
2. **Question handling** — When `question.asked` SSE event arrives, show inline buttons
   with the choices. When clicked, call `sdk.question.reply()` or `sdk.question.reject()`.
3. **`/cancel` command** — Abort generation via `sdk.session.abort({ sessionID })`.
4. **Typing indicator** — Show "typing..." continuously during active turns.

## Architecture

```
SSE Events
  → permission.asked
    → formatPermissionMessage() → send with inline keyboard
    → Store requestID in PendingRequests (for double-click protection + TTL)

  → question.asked
    → formatQuestionMessage() → send with inline keyboard
    → Store requestID + options in PendingRequests (for index→label resolution)

User clicks button (callback_query)
  → answerCallbackQuery() ALWAYS first
  → Parse callback_data: "perm:{reply}:{requestID}" or "q:{requestID}:{index}"
  → Look up PendingEntry (guard: expired → "This request has expired.")
  → Call sdk.permission.reply() or sdk.question.reply()/reject()
  → Edit original message to show the decision
  → Delete from PendingRequests (idempotency)

/cancel command
  → Look up session from SessionManager
  → Look up turn from TurnManager
  → Call sdk.session.abort({ sessionID })
  → Call turnManager.end(sessionID)
  → Reply "Generation cancelled."

Typing indicator
  → startTypingLoop(chatId, sendAction, signal)
  → sendChatAction("typing") every 4 seconds
  → Tied to turn's AbortSignal (auto-stops on end/abort)
```

## SDK API (verified from sdk.gen.ts)

```ts
// Permission — only requestID needed (no sessionID!)
sdk.permission.reply({ requestID, reply: "once" | "always" | "reject", message?: string })

// Question — only requestID needed
sdk.question.reply({ requestID, answers: [["selected_label"]] })
sdk.question.reject({ requestID })

// Abort — sessionID in path
sdk.session.abort({ sessionID })
```

## Callback Data Design (max 64 bytes)

```
Permission buttons:
  perm:once:{requestID}      → 10 + 30 = ~40 bytes ✓
  perm:always:{requestID}    → 12 + 30 = ~42 bytes ✓
  perm:deny:{requestID}      → 10 + 30 = ~40 bytes ✓

Question buttons:
  q:{requestID}:{index}      → 2 + 30 + 1 + 2 = ~35 bytes ✓
  q:{requestID}:skip         → 2 + 30 + 1 + 4 = ~37 bytes ✓
```

IDs: `per_` + 26 chars = 30 chars, `que_` + 26 chars = 30 chars. All fit comfortably.

## PendingRequests Design

```ts
type PendingEntry = {
  type: "permission" | "question"
  createdAt: number
  // Only for questions: store options for index→label resolution
  questions?: Array<{ options: Array<{ label: string }> }>
}
```

Why PendingRequests exists:
- **Questions**: REQUIRED — callback_data only holds index, need to resolve to label
- **Permissions**: OPTIONAL but useful — double-click protection + TTL expiry guard
- Bounded at 200 entries, TTL 10 minutes

## New Files

```
src/
  pending-requests.ts            ← Bounded Map<requestID, PendingEntry> with TTL
  pending-requests.test.ts       ← 7 tests
  handlers/
    permissions.ts               ← formatPermissionMessage(), parsePermissionCallback()
    permissions.test.ts          ← 8 tests
    questions.ts                 ← formatQuestionMessage(), parseQuestionCallback(), resolveQuestionAnswer()
    questions.test.ts            ← 9 tests
    cancel.ts                    ← handleCancel()
    cancel.test.ts               ← 5 tests
    typing.ts                    ← startTypingLoop()
    typing.test.ts               ← 4 tests
e2e/
  phase-2.test.ts                ← 3 E2E tests
```

## Modified Files

```
src/
  bot.ts                         ← Add /cancel, callback_query handler, BotDeps.pendingRequests
  bot.test.ts                    ← Update tests for new handlers
  index.ts                       ← Wire PendingRequests, add permission/question event cases,
                                    add typing indicator on turn start
```

## TDD Execution Order (bottom-up by dependency)

### 1. pending-requests.ts — Bounded request map (7 tests)
Pure data structure, zero dependencies.

Tests:
1. `set()` stores, `get()` retrieves
2. `get()` returns undefined for unknown requestID
3. `delete()` removes entry and returns true
4. `delete()` returns false for unknown requestID
5. Evicts oldest when maxEntries exceeded (bounded at 200)
6. `get()` returns undefined for expired entries (after TTL)
7. `cleanup()` removes all expired entries

### 2. handlers/permissions.ts — Permission formatting + parsing (8 tests)
Pure functions, depends only on types.

Functions:
- `formatPermissionMessage(perm)` → `{ text, reply_markup }`
- `parsePermissionCallback(data)` → `{ requestID, reply }` | null

Tests:
1. `formatPermissionMessage` text contains permission name
2. `formatPermissionMessage` text contains patterns
3. `formatPermissionMessage` returns keyboard with 3 buttons (Allow/Always/Deny)
4. Callback data follows pattern `perm:{action}:{requestID}`
5. `parsePermissionCallback("perm:once:per_abc123")` → `{ requestID, reply: "once" }`
6. `parsePermissionCallback("perm:always:per_abc123")` → `{ reply: "always" }`
7. `parsePermissionCallback("perm:deny:per_abc123")` → `{ reply: "reject" }`
8. `parsePermissionCallback("invalid:data")` → null

### 3. handlers/questions.ts — Question formatting + parsing (9 tests)
Pure functions, depends only on types.

Functions:
- `formatQuestionMessage(questionEvent)` → `{ text, reply_markup }`
- `parseQuestionCallback(data)` → `{ requestID, action, optionIndex? }` | null
- `resolveQuestionAnswer(optionIndex, pending)` → `string[]`

Tests:
1. `formatQuestionMessage` returns question text in message
2. `formatQuestionMessage` renders options as 1-per-row buttons
3. `formatQuestionMessage` adds "Skip" button as last row
4. Callback data: `q:{requestID}:{index}` for selection
5. Callback data: `q:{requestID}:skip` for skip
6. `parseQuestionCallback("q:que_abc:0")` → `{ requestID, action: "select", optionIndex: 0 }`
7. `parseQuestionCallback("q:que_abc:skip")` → `{ requestID, action: "skip" }`
8. `parseQuestionCallback("invalid")` → null
9. `resolveQuestionAnswer(0, pending)` maps index to option label

### 4. handlers/cancel.ts — /cancel command (5 tests)
Depends on SessionManager + TurnManager (existing).

Tests:
1. Returns "No active session." if no session found
2. Returns "Nothing running." if session exists but no active turn
3. Calls `sdk.session.abort({ sessionID })` when turn is active
4. Calls `turnManager.end(sessionID)` after abort
5. Returns "Generation cancelled." on success

### 5. handlers/typing.ts — Typing indicator loop (4 tests)
Pure function, depends only on AbortSignal.

Tests:
1. Calls sendAction immediately on start
2. Calls sendAction again after ~4 seconds (fake timers)
3. Stops calling when signal is aborted
4. Does not throw if sendAction rejects

### 6. Modified: bot.ts — Callback query handler + /cancel + typing
- Extend BotDeps with `pendingRequests: PendingRequests`
- Add `bot.command("cancel", ...)` that calls handleCancel
- Add `bot.on("callback_query:data", ...)` routing perm: and q: prefixes
- Change handleMessage return type to `{ turn: ActiveTurn }`
- Start typing loop after handleMessage in Grammy handler

### 7. Modified: index.ts — Wire new event types + PendingRequests
- Create PendingRequests instance (maxEntries: 200, ttlMs: 10min)
- Handle `permission.asked` → formatPermissionMessage + sendMessage + store in PendingRequests
- Handle `question.asked` → formatQuestionMessage + sendMessage + store in PendingRequests
- Typing indicator started from bot.ts Grammy handler (not index.ts)

## Edge Cases (Phase 2 MVP decisions)

- **"Always" auto-resolve**: Server may auto-resolve other permissions. Stale buttons handled
  gracefully ("requestID not found" → "This request has expired.")
- **Double-click**: PendingRequests.delete() on first click prevents duplicate SDK calls
- **TTL expiry**: Clicking button after 10min → "This request has expired."
- **`answerCallbackQuery()` mandatory**: Always call first, prevents Telegram loading spinner
- **`multiple: true` questions**: Not supported in Phase 2 MVP (single-select only)
- **`custom: true` questions**: Not supported (no text input in inline keyboards)
- **Multiple questions per event**: Phase 2 handles first question only (rare in practice)

## Acceptance Criteria

- [ ] Permission request shows inline buttons (Allow/Always/Deny)
- [ ] Clicking Allow continues AI generation
- [ ] Clicking Deny stops the tool call
- [ ] Question shows options as inline buttons
- [ ] Clicking option sends reply to SDK
- [ ] Clicking Skip rejects the question
- [ ] `/cancel` aborts running generation
- [ ] Typing indicator active during turn
- [ ] Button messages are edited after click (show decision)
- [ ] Expired/unknown requests handled gracefully
- [ ] `bun test` passes (all unit tests)
- [ ] `bun test ./e2e/phase-2.test.ts` passes
- [ ] All Phase 0-1 E2E tests still pass (regression)

## Estimated Scope

- 5 new source files + 5 test files + 1 E2E test file
- ~400-500 LOC (src) + ~300-400 LOC (tests)
- Modified: bot.ts, index.ts
