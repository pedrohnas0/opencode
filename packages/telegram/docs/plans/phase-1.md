# Phase 1 — Core Loop (MVP)

**Goal:** Send a text message → OpenCode processes it → formatted response in Telegram.

## What This Phase Delivers

The minimum viable bot: a user sends a message, OpenCode's AI processes it,
and the bot replies with a formatted response. This is the foundation everything
else builds on.

## Architecture

```
User sends text message
  → bot.on("message")
    → SessionManager.getOrCreate(chatId) → OpenCode session
    → sdk.session.prompt({ parts: [{ type: "text", text }] })

[EventBus receives SSE events]
  → message.part.updated (type: "text") → accumulate text
  → session.idle → send final formatted response
  → session.error → send error message
```

## New Files

```
src/
  sdk.ts                        ← SDK client factory (createOpencode wrapper)
  sdk.test.ts
  session-manager.ts            ← LRU Map<chatKey, SessionEntry>
  session-manager.test.ts
  turn-manager.ts               ← Per-turn lifecycle (AbortController)
  turn-manager.test.ts
  event-bus.ts                  ← Single SSE connection + dispatcher
  event-bus.test.ts
  send/
    format.ts                   ← Markdown → Telegram HTML
    format.test.ts
    chunker.ts                  ← Split messages at 4096 chars
    chunker.test.ts
e2e/
  phase-1.test.ts
```

## Modified Files

```
src/
  bot.ts                        ← Add message handler, /new command
  bot.test.ts                   ← Add tests for message handler
  index.ts                      ← Initialize SDK, SessionManager, EventBus, TurnManager
```

## TDD Execution Order (bottom-up by dependency)

### 1. send/format.ts — Markdown → Telegram HTML
Pure function, zero dependencies. Tests:
- Bold: `**text**` → `<b>text</b>`
- Italic: `*text*` → `<i>text</i>`
- Code: `` `text` `` → `<code>text</code>`
- Code block: ``` ```ts\ncode``` ``` → `<pre><code class="language-ts">code</code></pre>`
- Links: `[text](url)` → `<a href="url">text</a>`
- HTML escaping: `& < >` → `&amp; &lt; &gt;`
- Nested: `**bold and *italic***`
- Edge: empty string, already-escaped HTML

### 2. send/chunker.ts — Message splitting
Pure function. Tests:
- Short message (< 4096) returns single chunk
- Long message splits at ~4096 boundary
- Never splits inside HTML tags
- Preserves unclosed tags across chunks (close + reopen)
- Empty string returns empty array

### 3. session-manager.ts — LRU session map
Tests:
- `getOrCreate` creates session via SDK on first access
- `getOrCreate` returns cached on second access (SDK not called again)
- `get` returns entry by chatKey
- `getBySessionId` reverse lookup
- `remove` clears both maps
- Evicts oldest when maxEntries exceeded
- Expired entries cleaned up by TTL
- `set` allows manual session binding (for /list switch)

### 4. turn-manager.ts — Turn lifecycle
Tests:
- `start` creates AbortController for session
- `get` returns active turn
- `end` aborts controller, clears timers, removes entry
- `addTimer` / end clears all timers
- `abortAll` cleans up everything
- No leak: ended turn has no remaining references

### 5. event-bus.ts — SSE event routing
Tests (with mock SSE stream):
- Routes event to correct chatKey via SessionManager reverse lookup
- Ignores events for unknown sessionIds
- Calls onEvent with (sessionId, chatKey, event)
- Reconnects on stream end (mock reconnect)
- stop() cleans up (aborts, no more events)

### 6. bot.ts — Message handler + /new
Tests:
- Text message calls sdk.session.prompt with correct parts
- /new command removes old session mapping, creates new one
- Message to unknown chat creates session automatically

### 7. Integration: index.ts wiring
No unit test — validated by E2E.

## E2E Tests (phase-1.test.ts)

```ts
test("text message gets AI response", async () => {
  const reply = await sendAndWait(client, BOT, "Say the word hello", 30000)
  assertContains(reply, /hello/i)
})

test("/new creates fresh session", async () => {
  const reply = await sendAndWait(client, BOT, "/new")
  assertContains(reply, /session/i)
})

test("error is shown in chat", async () => {
  // Depends on OpenCode server behavior
  // May need specific prompt to trigger error
})
```

## Key Implementation Decisions

### SDK initialization
Following Slack bot pattern — spawn local OpenCode server:
```ts
import { createOpencode } from "@opencode-ai/sdk"
const opencode = await createOpencode({ port: 0 })
```
This makes the bot self-contained. No external server needed.

### Single SSE connection
One `opencode.client.event.subscribe()` for ALL sessions.
Events routed via SessionManager's reverse map (sessionId → chatKey).

### Text accumulation
On `message.part.updated` with `part.type === "text"`, we replace (not append)
the accumulated text — the SDK sends the full text each time, not deltas.

### Response delivery (Phase 1 — no streaming)
Wait for `session.idle`, then send the complete formatted response.
Draft streaming comes in Phase 3.

### Anti-leak measures active from day 1
- SessionManager: LRU with maxEntries + TTL
- TurnManager: AbortController per turn, auto-cleanup on end
- EventBus: single connection, AbortController for shutdown
- No Grammy ctx stored in closures — extract chatId/text immediately

## Acceptance Criteria

- [ ] Text message → prompt → SSE → formatted reply in chat
- [ ] `/new` creates fresh session
- [ ] Long response (>4096 chars) is chunked correctly
- [ ] Markdown converted to Telegram HTML
- [ ] HTML parse errors fall back to plain text
- [ ] Errors shown in chat
- [ ] `bun test src/` passes (all unit tests, including Phase 0)
- [ ] `bun test ./e2e/phase-1.test.ts` passes
- [ ] `bun test ./e2e/phase-0.test.ts` still passes (regression)

## Estimated Scope

- ~6 new source files + 6 test files
- ~800-1000 LOC (src) + ~400-500 LOC (tests)
- Heaviest files: event-bus.ts, format.ts, session-manager.ts
