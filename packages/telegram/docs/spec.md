# OpenCode Telegram Bot — Full Technical Specification

Comprehensive implementation guide for a Telegram bot that interfaces with the OpenCode SDK,
modeled after the OpenClaw Telegram integration (~6,500 LOC) but using the SDK HTTP client
pattern (like the web app) instead of direct agent integration.

---

## 1. Architecture Overview

### 1.1 Design Philosophy

The bot acts as a **thin Telegram ↔ OpenCode SDK bridge**:

```
Telegram Bot API ←→ [Grammy Bot] ←→ [OpenCode SDK Client] ←→ OpenCode Server
```

Unlike OpenClaw (which integrates directly with its own AI agent system), we delegate
**all AI work** to the OpenCode server via its HTTP SDK. The bot is responsible only for:
- Translating Telegram messages → SDK `session.prompt()` calls
- Translating SDK SSE events → Telegram responses
- Managing the lifecycle mapping between Telegram chats and OpenCode sessions

### 1.2 Anti-Leak Architecture

Every component is designed to prevent memory leaks:

```
┌──────────────────────────────────────────────────────────┐
│                     Grammy Bot                           │
│  - Stateless handlers (extract minimal data from ctx)    │
│  - Never close over full Grammy Context                  │
└─────────────────────┬────────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────────┐
│                  SessionManager                          │
│  - LRU<chatKey, SessionEntry> with TTL (30min default)   │
│  - Max entries cap (e.g. 500)                            │
│  - SessionEntry = { sessionId, directory, createdAt }    │
│  - Eviction: remove from map only (sessions persist      │
│    in OpenCode server, re-hydrate via session.list())    │
└─────────────────────┬────────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────────┐
│              EventBus (Single SSE)                        │
│  - ONE connection to global.event()                      │
│  - Routes events by sessionId → chatId via SessionManager│
│  - AbortController for clean shutdown                    │
│  - Auto-reconnect with exponential backoff               │
│  - Listeners registered with { signal } for cleanup      │
└─────────────────────┬────────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────────┐
│                   TurnManager                            │
│  - 1 AbortController per active turn (sessionId → ctrl)  │
│  - Tracks: draft message ref, timers                     │
│  - abort() on: session.idle, /cancel, error              │
│  - Auto-cleanup everything on turn end                   │
└─────────────────────┬────────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────────┐
│                  ResponseSender                          │
│  - Stateless: receives (chatId, text, opts)              │
│  - Markdown → Telegram HTML conversion                   │
│  - Chunking (4096 char limit)                            │
│  - No persistent references to sent messages             │
└──────────────────────────────────────────────────────────┘
```

**Anti-leak rules:**
1. Every resource that opens must close — SSE, AbortController, timers
2. No `Map` without bounds — LRU or TTL on everything
3. Callback data encoded in strings — zero in-memory storage
4. AbortController per turn — one `abort()` cleans all listeners + timers
5. Closures capture primitives (chatId, sessionId) — never objects (ctx, msg)

### 1.3 SDK Connection

```ts
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"

// One client per project directory
const sdk = createOpencodeClient({
  baseUrl: "http://127.0.0.1:4096",
  directory: "/path/to/project",
})
```

The SDK client is stateless (HTTP). Each call includes the `x-opencode-directory` header.
No connection pooling or persistent state in the client itself.

---

## 2. Testing Strategy

### 2.1 Overview

Two testing layers, both mandatory per phase:

```
┌────────────────────────────────────────────────────┐
│  Unit Tests (bun test)                             │
│  - Mocks for SDK + Telegram API                    │
│  - 1 test file per source file (colocated)         │
│  - TDD: RED → GREEN → REFACTOR                    │
│  - Runs in CI, no external dependencies            │
└────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────┐
│  E2E Tests (gramjs userbot)                        │
│  - Real Telegram (test env) + real bot             │
│  - Automated: no human interaction needed          │
│  - Validates full flow per phase                   │
│  - Phase gate: all E2E green → next phase          │
└────────────────────────────────────────────────────┘
```

### 2.2 TDD Workflow (AI-Optimized)

Standard TDD but optimized for AI pair programming — the RED phase
does NOT execute tests (the AI already knows they'll fail since the
implementation doesn't exist yet). This saves tokens and time.

```
RED:      Write complete test file (don't run)
GREEN:    Write implementation → run bun test → pass
REFACTOR: Clean up → run bun test → still passes
```

**Per-file cycle:**
```
1. Write  session-manager.test.ts   (RED — no execution)
2. Write  session-manager.ts        (GREEN)
3. Run    bun test src/session-manager.test.ts  (validate)
4. Refactor if needed               (REFACTOR)
5. Run    bun test src/session-manager.test.ts  (confirm)
```

**Execution order per phase** — bottom-up by dependency:
```
Phase 1 example:
  RED+GREEN: format.test.ts         → format.ts
  RED+GREEN: chunker.test.ts        → chunker.ts
  RED+GREEN: session-manager.test.ts → session-manager.ts
  RED+GREEN: turn-manager.test.ts    → turn-manager.ts
  RED+GREEN: event-bus.test.ts       → event-bus.ts
  RED+GREEN: bot.test.ts             → bot.ts
  ─────────────────────────────────
  bun test                           → all green
  E2E: phase-1.test.ts              → real validation
```

### 2.3 Test File Convention

Colocated, 1:1 with source (following OpenClaw pattern):

```
src/
  session-manager.ts
  session-manager.test.ts      ← same directory
  turn-manager.ts
  turn-manager.test.ts
  event-bus.ts
  event-bus.test.ts
  send/
    format.ts
    format.test.ts
    chunker.ts
    chunker.test.ts
e2e/
  client.ts                    ← gramjs userbot wrapper
  helpers.ts                   ← sendAndWait(), clickButton(), assertReply()
  runner.ts                    ← setup/teardown bot + client
  phase-0.test.ts
  phase-1.test.ts
  phase-2.test.ts
  ...
```

### 2.4 Unit Test Pattern

```ts
import { describe, test, expect, beforeEach, mock } from "bun:test"
import { SessionManager } from "./session-manager"

// Mock SDK — minimal interface matching only what's needed
const createMockSdk = (sessionId: string) => ({
  session: { create: mock(async () => ({ data: { id: sessionId } })) },
})

describe("SessionManager", () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager({ maxEntries: 3, ttlMs: 1000 })
  })

  test("getOrCreate creates new session on first access", async () => {
    const sdk = createMockSdk("s1")
    const entry = await sm.getOrCreate("chat:1", sdk as any)
    expect(entry.sessionId).toBe("s1")
    expect(sdk.session.create).toHaveBeenCalledTimes(1)
  })

  test("getOrCreate returns cached on second access", async () => {
    const sdk = createMockSdk("s1")
    await sm.getOrCreate("chat:1", sdk as any)
    const entry = await sm.getOrCreate("chat:1", sdk as any)
    expect(entry.sessionId).toBe("s1")
    expect(sdk.session.create).toHaveBeenCalledTimes(1) // not called again
  })

  test("evicts oldest when maxEntries exceeded", async () => {
    for (let i = 1; i <= 4; i++) {
      await sm.getOrCreate(`chat:${i}`, createMockSdk(`s${i}`) as any)
    }
    expect(sm.get("chat:1")).toBeUndefined()  // evicted
    expect(sm.get("chat:4")?.sessionId).toBe("s4")
  })

  test("getBySessionId reverse lookup", async () => {
    await sm.getOrCreate("chat:1", createMockSdk("s1") as any)
    expect(sm.getBySessionId("s1")?.chatKey).toBe("chat:1")
  })

  test("remove clears both maps", async () => {
    await sm.getOrCreate("chat:1", createMockSdk("s1") as any)
    sm.remove("chat:1")
    expect(sm.get("chat:1")).toBeUndefined()
    expect(sm.getBySessionId("s1")).toBeUndefined()
  })

  test("expired entries cleaned up", async () => {
    await sm.getOrCreate("chat:1", createMockSdk("s1") as any)
    await new Promise(r => setTimeout(r, 1100))
    sm.cleanup()
    expect(sm.get("chat:1")).toBeUndefined()
  })
})
```

### 2.5 E2E Infrastructure

**Components:**

```
┌─────────────────────────────┐
│   E2E Test Runner (gramjs)  │  ← automated test user account
│   Sends msgs, clicks btns   │
│   Verifies bot responses     │
└──────────────┬──────────────┘
               │ MTProto (test DC)
┌──────────────▼──────────────┐
│    Bot (Grammy)              │  ← our bot, running against test env
│    test API root             │
└──────────────┬──────────────┘
               │ HTTP
┌──────────────▼──────────────┐
│    OpenCode Server           │  ← real server (or mock for CI)
└──────────────────────────────┘
```

**gramjs client wrapper (`e2e/client.ts`):**

```ts
import { TelegramClient } from "telegram"
import { StringSession } from "telegram/sessions"

export async function createTestClient(config: {
  apiId: number
  apiHash: string
  session: string       // saved StringSession
}): Promise<TelegramClient> {
  const client = new TelegramClient(
    new StringSession(config.session),
    config.apiId,
    config.apiHash,
    { connectionRetries: 3 }
  )
  await client.connect()
  return client
}
```

**Test helpers (`e2e/helpers.ts`):**

```ts
export async function sendAndWait(
  client: TelegramClient,
  botUsername: string,
  text: string,
  timeoutMs = 15000,
): Promise<Api.Message> {
  const before = Date.now()
  await client.sendMessage(botUsername, { message: text })

  // Poll for bot reply
  while (Date.now() - before < timeoutMs) {
    await sleep(500)
    const messages = await client.getMessages(botUsername, { limit: 1 })
    const latest = messages[0]
    if (latest && latest.date * 1000 > before && latest.out === false) {
      return latest
    }
  }
  throw new Error(`Bot did not reply within ${timeoutMs}ms`)
}

export async function clickInlineButton(
  client: TelegramClient,
  botUsername: string,
  msgId: number,
  buttonText: string,
): Promise<void> {
  const messages = await client.getMessages(botUsername, { ids: [msgId] })
  const msg = messages[0]
  const rows = msg.replyMarkup?.rows ?? []
  for (const row of rows) {
    for (const btn of row.buttons) {
      if (btn.text.includes(buttonText)) {
        await client.invoke(new Api.messages.GetBotCallbackAnswer({
          peer: botUsername,
          msgId,
          data: btn.data,
        }))
        return
      }
    }
  }
  throw new Error(`Button "${buttonText}" not found`)
}

export function assertContains(msg: Api.Message, pattern: string | RegExp): void {
  const text = msg.text ?? msg.message ?? ""
  if (typeof pattern === "string") {
    if (!text.includes(pattern)) throw new Error(`Expected "${pattern}" in: ${text}`)
  } else {
    if (!pattern.test(text)) throw new Error(`Expected ${pattern} in: ${text}`)
  }
}

export function assertHasButtons(msg: Api.Message): void {
  const rows = msg.replyMarkup?.rows ?? []
  if (rows.length === 0) throw new Error("Expected inline buttons, got none")
}
```

**Test runner (`e2e/runner.ts`):**

```ts
import { spawn, type Subprocess } from "bun"

let botProcess: Subprocess | null = null

export async function setup() {
  // Start bot as subprocess
  botProcess = spawn(["bun", "run", "src/index.ts"], {
    env: { ...process.env, TELEGRAM_TEST_ENV: "1" },
    stdout: "pipe",
  })
  // Wait for bot to be ready
  await waitForBotReady()
}

export async function teardown() {
  botProcess?.kill()
  botProcess = null
}
```

### 2.6 E2E Tests per Phase

**Phase 0:**
```ts
test("bot responds to /start", async () => {
  const reply = await sendAndWait(client, BOT, "/start")
  assertContains(reply, /OpenCode/)
})
```

**Phase 1:**
```ts
test("text message gets AI response", async () => {
  const reply = await sendAndWait(client, BOT, "Say the word hello", 30000)
  assertContains(reply, /hello/i)
})

test("/new creates fresh session", async () => {
  const reply = await sendAndWait(client, BOT, "/new")
  assertContains(reply, /session/i)
})

test("long response is chunked correctly", async () => {
  const reply = await sendAndWait(client, BOT, "List all US states with capitals", 30000)
  // Should receive at least one message
  assertContains(reply, /.+/)
})
```

**Phase 2:**
```ts
test("permission request shows buttons", async () => {
  const reply = await sendAndWait(client, BOT, "Create a file called test.txt", 20000)
  // Should eventually get a permission request with buttons
  // (may need to poll multiple messages)
  assertHasButtons(reply)
})

test("clicking Allow continues generation", async () => {
  const permMsg = await sendAndWait(client, BOT, "Run ls -la", 20000)
  await clickInlineButton(client, BOT, permMsg.id, "Allow")
  const result = await waitForBotReply(15000)
  assertContains(result, /.+/)
})

test("/cancel aborts generation", async () => {
  await client.sendMessage(BOT, { message: "Write a very long essay about history" })
  await sleep(2000)
  const reply = await sendAndWait(client, BOT, "/cancel")
  assertContains(reply, /cancel/i)
})
```

**Phase 3:**
```ts
test("response streams via message edits", async () => {
  await client.sendMessage(BOT, { message: "Explain what TypeScript is" })
  // Poll message and check it's being edited (text grows)
  await sleep(2000)
  const msg1 = (await client.getMessages(BOT, { limit: 1 }))[0]
  await sleep(3000)
  const msg2 = (await client.getMessages(BOT, { ids: [msg1.id] }))[0]
  // Same message ID, but text may have grown
  expect(msg2.id).toBe(msg1.id)
})
```

**Phase 4:**
```ts
test("/list shows sessions with buttons", async () => {
  const reply = await sendAndWait(client, BOT, "/list")
  assertHasButtons(reply)
})

test("/rename changes session title", async () => {
  const reply = await sendAndWait(client, BOT, "/rename My Test Session")
  assertContains(reply, /renamed|My Test Session/i)
})

test("/delete removes session", async () => {
  await sendAndWait(client, BOT, "/new")
  const reply = await sendAndWait(client, BOT, "/delete")
  assertContains(reply, /deleted/i)
})
```

**Phase 5:**
```ts
test("/model shows provider keyboard", async () => {
  const reply = await sendAndWait(client, BOT, "/model")
  assertHasButtons(reply)
})

test("/agent shows agent keyboard", async () => {
  const reply = await sendAndWait(client, BOT, "/agent")
  assertHasButtons(reply)
})
```

**Phase 6:**
```ts
test("photo attachment is processed", async () => {
  await client.sendFile(BOT, { file: "e2e/fixtures/test-image.png" })
  const reply = await waitForBotReply(20000)
  assertContains(reply, /.+/)  // bot acknowledged the image
})

test("document attachment is processed", async () => {
  await client.sendFile(BOT, { file: "e2e/fixtures/test.txt" })
  const reply = await waitForBotReply(20000)
  assertContains(reply, /.+/)
})
```

**Phase 7:**
```ts
test("/diff shows file changes", async () => {
  await sendAndWait(client, BOT, "Create a file called hello.py with print('hi')", 30000)
  const reply = await sendAndWait(client, BOT, "/diff")
  assertContains(reply, /hello\.py|diff|change/i)
})

test("/todo shows task list", async () => {
  const reply = await sendAndWait(client, BOT, "/todo")
  // May be empty or have items
  assertContains(reply, /.+/)
})

test("shell mode executes command", async () => {
  const reply = await sendAndWait(client, BOT, "!echo hello from shell", 15000)
  assertContains(reply, /hello from shell/i)
})
```

### 2.7 Phase Gate Rule

```
Phase N is COMPLETE when:
  1. All unit tests pass:  bun test
  2. All E2E tests pass:   bun test:e2e --filter="phase-[0-N]"
  3. No regressions:       all previous phase E2E tests still green

Phase N+1 CANNOT start until Phase N is COMPLETE.
```

### 2.8 CI Script

```bash
# Unit tests (fast, no external deps)
bun test

# E2E tests (requires running bot + test Telegram account)
TELEGRAM_TEST_ENV=1 bun run e2e/runner.ts setup
bun test e2e/
bun run e2e/runner.ts teardown
```

---

## 3. OpenCode SDK — What We Use

### 3.1 Session Lifecycle

| Method | Signature | Purpose |
|--------|-----------|---------|
| `session.create()` | `() → { data: Session }` | Create new session |
| `session.list()` | `() → { data: Session[] }` | List all sessions |
| `session.get()` | `({ id }) → { data: Session }` | Get specific session |
| `session.update()` | `({ id, title })` | Rename session |
| `session.delete()` | `({ id })` | Delete session |
| `session.abort()` | `({ sessionID })` | Cancel running response |
| `session.fork()` | `({ id, messageID })` | Fork from message |
| `session.share()` | `({ id }) → { data: { share: { url } } }` | Get share URL |
| `session.unshare()` | `({ id })` | Remove sharing |
| `session.status()` | `() → { data: SessionStatus }` | Busy/idle per session |

**Session type:**
```ts
type Session = {
  id: string
  slug: string
  projectID: string
  directory: string
  parentID?: string
  title: string
  version: string
  time: { created: number; updated: number; archived?: number }
  share?: { url: string }
  summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] }
}
```

### 3.2 Messaging

| Method | Signature | Purpose |
|--------|-----------|---------|
| `session.prompt()` | `({ sessionID, parts, agent, model, variant, messageID })` | Send user message |
| `session.shell()` | `({ sessionID, command, agent, model })` | Execute shell command |
| `session.command()` | `({ sessionID, command, arguments, agent, model, variant, parts })` | Execute slash command |
| `session.messages()` | `({ id, cursor? })` | Get message history (paginated) |
| `session.message()` | `({ id, messageID })` | Get single message |
| `session.summarize()` | `({ id })` | Summarize session |
| `session.revert()` | `({ id, messageID })` | Revert to message |
| `session.unrevert()` | `({ id })` | Undo revert |
| `session.diff()` | `({ id })` | Get file diffs |
| `session.todo()` | `({ id })` | Get task list |

**Prompt parts (what we send):**
```ts
type TextPartInput = { id: string; type: "text"; text: string; synthetic?: boolean }
type FilePartInput = { id: string; type: "file"; mime: string; url: string; filename?: string }
type AgentPartInput = { id: string; type: "agent"; name: string }
```

**For images/files from Telegram, we'd download them and send as `file://` URLs or data URLs.**

### 3.3 SSE Events

**Connection:** `sdk.event.subscribe()` returns an async iterable of `Event` objects.
For global events: we listen to `global.event()` which wraps each event in `{ directory, payload }`.

**Key event types for the Telegram bot:**

| Event Type | Properties | Action |
|------------|------------|--------|
| `message.updated` | `{ info: Message }` | New/updated message (both user and assistant) |
| `message.part.updated` | `{ part: Part, delta?: string }` | Text streaming, tool calls, reasoning |
| `message.removed` | `{ sessionID, messageID }` | Message deleted |
| `session.status` | `{ sessionID, status: SessionStatus }` | Busy/idle/retry |
| `session.idle` | `{ sessionID }` | Turn complete |
| `session.error` | `{ sessionID?, error? }` | Error occurred |
| `session.created` | `{ info: Session }` | New session |
| `session.updated` | `{ info: Session }` | Session metadata changed |
| `session.deleted` | `{ info: Session }` | Session deleted |
| `session.diff` | `{ sessionID, diff: FileDiff[] }` | File diffs updated |
| `todo.updated` | `{ sessionID, todos: Todo[] }` | Todo list changed |
| `permission.asked` | PermissionRequest | Permission needed |
| `permission.replied` | `{ sessionID, requestID, reply }` | Permission answered |
| `question.asked` | QuestionRequest | Question to user |
| `question.replied` | `{ sessionID, requestID, answers }` | Question answered |
| `question.rejected` | `{ sessionID, requestID }` | Question rejected |

**Part types (what the assistant sends back):**
```ts
type Part =
  | TextPart          // { type: "text", text: string }
  | ToolPart          // { type: "tool", tool: string, state: ToolState }
  | ReasoningPart     // { type: "reasoning", text: string }
  | FilePart          // { type: "file", mime, url, filename }
  | SubtaskPart       // { type: "subtask", description, agent }
  | StepStartPart     // { type: "step-start" }
  | StepFinishPart    // { type: "step-finish", cost, tokens }
  | SnapshotPart      // { type: "snapshot" }
  | PatchPart         // { type: "patch", hash, files }
  | CompactionPart    // { type: "compaction", auto }
  | RetryPart         // { type: "retry", attempt, error }

// Tool states:
type ToolState =
  | { status: "pending", input }
  | { status: "running", input, title?, time: { start } }
  | { status: "completed", input, output, title, time: { start, end } }
  | { status: "error", input, error, time: { start, end } }
```

### 3.4 Permissions

```ts
type PermissionRequest = {
  id: string
  sessionID: string
  permission: string        // e.g. "bash", "edit", "write"
  patterns: string[]        // e.g. ["rm -rf *"]
  metadata: Record<string, unknown>
  always: string[]          // available "always" patterns
  tool?: { messageID: string; callID: string }
}

// Respond:
sdk.permission.respond({
  id: permissionRequest.id,
  sessionID: permissionRequest.sessionID,
  reply: "once" | "always" | "reject"
})
```

### 3.5 Questions

```ts
type QuestionRequest = {
  id: string
  sessionID: string
  questions: Array<{
    question: string
    header: string          // short label (max 30 chars)
    options: Array<{ label: string; description: string }>
    multiple?: boolean
    custom?: boolean
  }>
}

// Reply:
sdk.question.reply({
  id: questionRequest.id,
  sessionID: questionRequest.sessionID,
  answers: [["selected_option"]]   // Array<Array<string>>
})

// Reject:
sdk.question.reject({
  id: questionRequest.id,
  sessionID: questionRequest.sessionID,
})
```

### 3.6 Other Useful Endpoints

| Method | Purpose |
|--------|---------|
| `app.agents()` | List available agents (name, description, color) |
| `provider.list()` | List providers with their models |
| `provider.auth()` | Check provider auth status |
| `config.get()` | Get project config |
| `command.list()` | List available slash commands |
| `global.health()` | Health check |
| `vcs.get()` | Git branch info |

---

## 4. OpenClaw Telegram — Reference Patterns

### 4.1 Message Flow

OpenClaw's message flow (what we adapt to SDK):

```
Telegram Update
  → bot.on("message") [bot-handlers.ts:668]
    → Access control (allowlists, group policy) [bot-handlers.ts:695-773]
    → Text fragment assembly (>4000 chars split) [bot-handlers.ts:776-836]
    → Media group buffering [bot-handlers.ts:839-870]
    → Media resolution (download) [bot/delivery.ts:294]
    → Inbound debouncing [bot-handlers.ts:916]
    → processMessage() [bot-message.ts:27]
      → buildTelegramMessageContext() [bot-message-context.ts:127]
        → Route resolution (session key)
        → DM/Group access control
        → Mention detection
        → ACK reaction
        → Format inbound envelope
      → dispatchTelegramMessage() [bot-message-dispatch.ts:60]
        → Draft stream setup [bot-message-dispatch.ts:99-109]
        → Typing indicator
        → dispatchReplyWithBufferedBlockDispatcher()
          → AI agent processes message
          → Partial replies → update draft stream
          → Final reply → deliverReplies()
        → Draft stream stop
        → ACK reaction cleanup
```

**Our equivalent (SDK-based):**

```
Telegram Update
  → bot.on("message")
    → Extract chatId, text, media (minimal from ctx)
    → SessionManager.getOrCreate(chatId) → sessionId
    → sdk.session.prompt({ sessionID, parts: [...] })
    → TurnManager.start(sessionId, chatId)

[Meanwhile, EventBus receives SSE events]
  → message.part.updated (type: "text")
    → DraftStream.update(text) [edit message in real-time]
  → message.part.updated (type: "tool")
    → Show tool progress in chat
  → permission.asked
    → Send inline keyboard (Allow/Deny/Always)
  → question.asked
    → Send inline keyboard with options
  → session.idle
    → DraftStream.stop()
    → Send final formatted response
    → TurnManager.end(sessionId)
```

### 4.2 Draft Streaming Pattern (from OpenClaw)

OpenClaw uses `sendMessageDraft` (Telegram Business API) for live streaming.
For our MVP, we'll use `editMessageText` instead (more broadly available):

```ts
// OpenClaw pattern [draft-stream.ts:13-139]:
// - Throttled at 300ms intervals
// - Max 4096 chars per draft
// - Graceful fallback on failure
// - pendingText / inFlight / timer pattern prevents race conditions

// Our adaptation:
function createDraftEditor(params: {
  bot: Bot
  chatId: number
  messageId: number    // the "placeholder" message we edit
  maxChars: number     // 4096
  throttleMs: number   // 300-500ms
}): { update(text: string): void; stop(): void }
```

### 4.3 Inline Keyboard Patterns (from OpenClaw)

**Model selection** [model-buttons.ts]:
```
Callback data patterns (max 64 bytes):
- mdl_prov              → show providers list
- mdl_list_{prov}_{pg}  → show models for provider (page N)
- mdl_sel_{provider/id} → select model
- mdl_back              → back to providers

Keyboard layout:
- Provider buttons: 2 per row, showing "provider (count)"
- Model buttons: 1 per row, current model marked with ✓
- Pagination: ◀ Prev | 1/3 | Next ▶
- Back button at bottom
```

**Permission buttons** (our design):
```
Callback data patterns:
- perm:once:{requestId}
- perm:always:{requestId}
- perm:deny:{requestId}

Keyboard: [ ✓ Allow Once ] [ ✓ Always ] [ ✗ Deny ]
```

**Question buttons** (our design):
```
Callback data patterns:
- q:{requestId}:{optionIndex}
- q:{requestId}:reject

Keyboard: options as buttons, reject as last row
```

### 4.4 Message Formatting (from OpenClaw)

OpenClaw converts markdown → Telegram HTML [format.ts]:
```
**bold**     → <b>bold</b>
*italic*     → <i>italic</i>
~~strike~~   → <s>strike</s>
`code`       → <code>code</code>
```code```   → <pre><code>code</code></pre>
[text](url)  → <a href="url">text</a>
& < >        → &amp; &lt; &gt; (HTML entities)
```

Message chunking: split at 4096 chars preserving tag boundaries.
HTML parse errors: fall back to plain text (PARSE_ERR_RE pattern).

### 4.5 Media Handling (from OpenClaw)

OpenClaw resolves media from Telegram [bot/delivery.ts:294-436]:
```
Photo  → file = msg.photo[last] (highest resolution)
Video  → file = msg.video
Audio  → file = msg.audio or msg.voice
Doc    → file = msg.document
Sticker → file = msg.sticker (only static WEBP)

Download flow:
1. ctx.getFile() → { file_path }
2. fetch(https://api.telegram.org/file/bot{token}/{file_path})
3. Detect MIME type
4. Save to temp file
5. Return { path, contentType }
```

**Our adaptation**: Download → base64 data URL → send as FilePartInput in prompt.

---

## 5. Phase 0 — E2E Infrastructure + Bot Skeleton

**Goal:** Bot connects to Telegram test env, responds to `/start`. E2E runner can
send messages and verify responses automatically. This is the foundation for all
subsequent phases.

### 5.1 Files

```
opencode-telegram/
  src/
    index.ts              # Entry point (bot startup + graceful shutdown)
    bot.ts                # Grammy bot setup, /start handler
    config.ts             # Env vars: bot token, SDK URL, test env flag
    types.ts              # Shared types
  e2e/
    client.ts             # gramjs userbot wrapper (createTestClient)
    helpers.ts            # sendAndWait, clickInlineButton, assertContains
    runner.ts             # setup/teardown (spawn bot, connect client)
    phase-0.test.ts       # /start → verify response
  package.json
  tsconfig.json
  bunfig.toml             # bun test config
```

### 5.2 Config (`config.ts`)

```ts
export const config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  opencodeUrl: process.env.OPENCODE_URL ?? "http://127.0.0.1:4096",
  projectDirectory: process.env.OPENCODE_DIRECTORY ?? process.cwd(),
  testEnv: process.env.TELEGRAM_TEST_ENV === "1",

  // E2E test config (only used by test runner)
  e2e: {
    apiId: Number(process.env.TELEGRAM_API_ID ?? 0),
    apiHash: process.env.TELEGRAM_API_HASH ?? "",
    session: process.env.TELEGRAM_SESSION ?? "",
    botUsername: process.env.TELEGRAM_BOT_USERNAME ?? "",
  },
}
```

### 5.3 Bot Setup (`bot.ts`)

```ts
import { Bot } from "grammy"
import { config } from "./config"

export function createBot() {
  const bot = new Bot(config.botToken, {
    client: {
      // Use test API if configured
      ...(config.testEnv && {
        apiRoot: `https://api.telegram.org/bot${config.botToken}/test`,
      }),
    },
  })

  // /start command
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "OpenCode Telegram Bot\n\n" +
      "Send any message to start coding.\n" +
      "/new — New session\n" +
      "/cancel — Stop generation"
    )
  })

  return bot
}
```

### 5.4 Entry Point (`index.ts`)

```ts
import { createBot } from "./bot"

const bot = createBot()

// Graceful shutdown
const shutdown = async () => {
  await bot.stop()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

// Start polling
await bot.start({
  onStart: () => console.log("Bot started"),
})
```

### 5.5 E2E Test

```ts
// e2e/phase-0.test.ts
import { describe, test, beforeAll, afterAll } from "bun:test"
import { setup, teardown, getClient, getBotUsername } from "./runner"
import { sendAndWait, assertContains } from "./helpers"

describe("Phase 0 — Bot Skeleton", () => {
  beforeAll(async () => await setup())
  afterAll(async () => await teardown())

  test("bot responds to /start", async () => {
    const client = getClient()
    const reply = await sendAndWait(client, getBotUsername(), "/start")
    assertContains(reply, "OpenCode Telegram Bot")
  })

  test("bot ignores unknown commands gracefully", async () => {
    const client = getClient()
    // Should not crash — just no response or generic response
    await client.sendMessage(getBotUsername(), { message: "/nonexistent" })
    // No crash = pass
  })
})
```

### 5.6 Phase 0 TDD Order

```
RED+GREEN: config.test.ts  → config.ts    (env parsing, defaults)
RED+GREEN: bot.test.ts      → bot.ts       (/start handler returns expected text)
─────────────────────────────
bun test                     → unit green
E2E: phase-0.test.ts        → real validation
```

### 5.7 Phase 0 Acceptance Criteria

- [ ] `bun run src/index.ts` starts bot without errors
- [ ] Bot responds to `/start` in Telegram (test env)
- [ ] E2E runner connects as userbot, sends `/start`, gets reply
- [ ] `bun test` passes (unit)
- [ ] `bun test e2e/phase-0.test.ts` passes (E2E)
- [ ] Graceful shutdown on SIGINT

---

## 6. Phase 1 — Core Loop (MVP)

**Goal:** Send a message, get a response. The absolute minimum working bot.

### 6.1 Files

```
opencode-telegram/
  src/
    index.ts              # Entry point
    bot.ts                # Grammy bot setup
    sdk.ts                # SDK client factory
    session-manager.ts    # LRU Map<chatKey, SessionEntry>
    event-bus.ts          # Single SSE connection + dispatcher
    turn-manager.ts       # Per-turn lifecycle (AbortController)
    send/
      format.ts           # Markdown → Telegram HTML
      chunker.ts          # Split at 4096 chars
    config.ts             # Bot token, SDK URL, etc.
    types.ts              # Shared types
```

### 6.2 Entry Point (`index.ts`)

```ts
// 1. Load config (bot token, opencode URL, project directory)
// 2. Create SDK client
// 3. Create Grammy bot with sequentialize + throttle
// 4. Create SessionManager (LRU, max 500, TTL 30min)
// 5. Create EventBus (single SSE to sdk.event.subscribe())
// 6. Create TurnManager
// 7. Register handlers
// 8. Start polling (or webhook)
// 9. Graceful shutdown on SIGINT/SIGTERM
```

### 6.3 Session Manager (`session-manager.ts`)

```ts
type SessionEntry = {
  sessionId: string
  directory: string
  createdAt: number
  lastAccessAt: number
}

class SessionManager {
  private map: Map<string, SessionEntry>  // chatKey → entry
  private reverseMap: Map<string, string> // sessionId → chatKey
  private readonly maxEntries: number
  private readonly ttlMs: number

  // chatKey = `${chatId}` for DMs, `${chatId}:topic:${threadId}` for forums

  async getOrCreate(chatKey: string, sdk: OpencodeClient): Promise<SessionEntry>
  get(chatKey: string): SessionEntry | undefined
  getBySessionId(sessionId: string): { chatKey: string; entry: SessionEntry } | undefined
  remove(chatKey: string): void
  private evict(): void  // remove oldest entries beyond maxEntries
  private cleanup(): void // remove expired entries (called periodically)
}
```

### 6.4 Event Bus (`event-bus.ts`)

```ts
class EventBus {
  private abortController: AbortController
  private reconnectAttempts: number
  private readonly sdk: OpencodeClient
  private readonly sessionManager: SessionManager
  private readonly onEvent: (sessionId: string, chatKey: string, event: Event) => void

  constructor(params: {
    sdk: OpencodeClient
    sessionManager: SessionManager
    onEvent: (sessionId: string, chatKey: string, event: Event) => void
  })

  async start(): Promise<void>   // connect SSE, start listening
  stop(): void                   // abort, clean up

  private async connect(): Promise<void> {
    // 1. Subscribe to SDK events
    // 2. For each event:
    //    a. Extract sessionId from event properties
    //    b. Look up chatKey via sessionManager.getBySessionId(sessionId)
    //    c. If found, call onEvent(sessionId, chatKey, event)
    // 3. On disconnect: reconnect with exponential backoff
  }
}
```

**Critical**: Only ONE SSE connection. Events are routed via the sessionManager's reverse map.

### 6.5 Turn Manager (`turn-manager.ts`)

```ts
type ActiveTurn = {
  sessionId: string
  chatId: number
  abortController: AbortController
  draftMessageId?: number
  timers: Set<ReturnType<typeof setTimeout>>
}

class TurnManager {
  private active: Map<string, ActiveTurn>  // sessionId → turn

  start(sessionId: string, chatId: number): ActiveTurn
  get(sessionId: string): ActiveTurn | undefined
  end(sessionId: string): void  // abort controller, clear timers, remove entry
  abort(sessionId: string): void // same as end() but also calls sdk.session.abort()

  addTimer(sessionId: string, timer: ReturnType<typeof setTimeout>): void
  clearTimer(sessionId: string, timer: ReturnType<typeof setTimeout>): void
}
```

### 6.6 Message Handler

```ts
bot.on("message", async (ctx) => {
  const msg = ctx.message
  if (!msg) return

  const chatId = msg.chat.id
  const text = msg.text?.trim()
  if (!text) return

  // Extract minimal data from ctx (never store ctx itself)
  const chatKey = String(chatId)

  // Get or create session
  const entry = await sessionManager.getOrCreate(chatKey, sdk)

  // Send typing indicator
  await bot.api.sendChatAction(chatId, "typing")

  // Start turn
  turnManager.start(entry.sessionId, chatId)

  // Send prompt to OpenCode
  await sdk.session.prompt({
    sessionID: entry.sessionId,
    parts: [{ id: generateId(), type: "text", text }],
  }).catch((err) => {
    bot.api.sendMessage(chatId, `Error: ${err.message}`)
    turnManager.end(entry.sessionId)
  })
})
```

### 6.7 Event Handling (in entry point)

```ts
const eventBus = new EventBus({
  sdk,
  sessionManager,
  onEvent: (sessionId, chatKey, event) => {
    const chatId = Number(chatKey.split(":")[0])

    switch (event.type) {
      case "message.part.updated": {
        const part = event.properties.part
        if (part.type === "text") {
          // Accumulate text, update draft (Phase 3) or store for final send
          turnState.accumulateText(sessionId, part.text)
        }
        if (part.type === "tool") {
          // Show tool progress (Phase 3)
        }
        break
      }
      case "session.idle": {
        // Turn complete — send final response
        const text = turnState.getFinalText(sessionId)
        if (text) {
          sendFormattedResponse(chatId, text)
        }
        turnManager.end(sessionId)
        break
      }
      case "session.error": {
        const error = event.properties.error
        bot.api.sendMessage(chatId, `Error: ${error?.data?.message ?? "Unknown error"}`)
        turnManager.end(sessionId)
        break
      }
      case "permission.asked": {
        // Phase 2: send inline keyboard
        break
      }
      case "question.asked": {
        // Phase 2: send inline keyboard
        break
      }
    }
  },
})
```

### 6.8 Response Formatting

```ts
// format.ts — simplified from OpenClaw's approach
function markdownToTelegramHtml(markdown: string): string {
  // Bold: **text** → <b>text</b>
  // Italic: *text* → <i>text</i>
  // Code: `text` → <code>text</code>
  // Code block: ```text``` → <pre><code>text</code></pre>
  // Links: [text](url) → <a href="url">text</a>
  // Escape: & < > → &amp; &lt; &gt;
}

// chunker.ts
function chunkMessage(html: string, limit = 4096): string[] {
  // Split at tag boundaries, never break inside tags
  // Each chunk ≤ limit chars
}

// Send with fallback
async function sendFormattedResponse(chatId: number, markdown: string) {
  const html = markdownToTelegramHtml(markdown)
  const chunks = chunkMessage(html)
  for (const chunk of chunks) {
    try {
      await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" })
    } catch (err) {
      // HTML parse error → retry as plain text
      if (/can't parse entities/i.test(String(err))) {
        await bot.api.sendMessage(chatId, markdown.slice(0, 4096))
      }
    }
  }
}
```

### 6.9 `/new` Command

```ts
bot.command("new", async (ctx) => {
  const chatId = ctx.message.chat.id
  const chatKey = String(chatId)

  // Remove existing session mapping (don't delete from OpenCode)
  sessionManager.remove(chatKey)

  // Create fresh session
  const entry = await sessionManager.getOrCreate(chatKey, sdk)

  await bot.api.sendMessage(chatId, `New session started.`)
})
```

### 6.10 `/start` Command

```ts
bot.command("start", async (ctx) => {
  await ctx.reply(
    "OpenCode Telegram Bot\n\n" +
    "Send any message to start coding.\n" +
    "/new — Start a new session\n" +
    "/cancel — Stop current generation"
  )
})
```

### 6.11 Phase 1 TDD Order

```
RED+GREEN: send/format.test.ts        → send/format.ts
RED+GREEN: send/chunker.test.ts        → send/chunker.ts
RED+GREEN: session-manager.test.ts     → session-manager.ts
RED+GREEN: turn-manager.test.ts        → turn-manager.ts
RED+GREEN: event-bus.test.ts           → event-bus.ts
RED+GREEN: bot.test.ts                 → bot.ts (message handler)
─────────────────────────────────
bun test                                → all unit green
E2E: phase-1.test.ts                   → real validation
```

### 6.12 Phase 1 Acceptance Criteria

- [ ] Text message → `session.prompt()` → SSE response → formatted reply in chat
- [ ] `/new` creates fresh session
- [ ] Long response (>4096 chars) is chunked correctly
- [ ] Markdown is converted to Telegram HTML
- [ ] HTML parse errors fall back to plain text
- [ ] Errors are shown in chat
- [ ] `bun test` passes (all unit tests)
- [ ] `bun test e2e/phase-1.test.ts` passes (E2E)
- [ ] All Phase 0 E2E tests still pass (regression)

---

## 7. Phase 2 — Interactive Controls

**Goal:** Handle permissions, questions, and abort — without these the AI agent gets stuck.

### 7.1 Permission Handling

```ts
// On permission.asked event:
case "permission.asked": {
  const perm = event.properties as PermissionRequest
  const description = `${perm.permission}: ${perm.patterns.join(", ")}`

  await bot.api.sendMessage(chatId, `Permission needed:\n<code>${escapeHtml(description)}</code>`, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "✓ Allow", callback_data: `perm:once:${perm.id}` },
        { text: "✓ Always", callback_data: `perm:always:${perm.id}` },
        { text: "✗ Deny", callback_data: `perm:deny:${perm.id}` },
      ]]
    }
  })
  break
}

// Callback handler:
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data
  if (!data) return
  await ctx.answerCallbackQuery()

  if (data.startsWith("perm:")) {
    const [, action, requestId] = data.split(":")
    // Find sessionId from the permission request
    const reply = action === "once" ? "once" : action === "always" ? "always" : "reject"
    await sdk.permission.respond({
      id: requestId,
      sessionID: /* lookup from turn or permission cache */,
      reply,
    })
    // Edit the message to show the decision
    await ctx.editMessageText(`Permission ${reply === "reject" ? "denied" : "granted"}: ${reply}`)
  }
})
```

**Key design: callback data encodes everything needed.** No in-memory storage for pending permissions.

To resolve sessionId from requestId, we keep a bounded Map<requestId, sessionId> with TTL
that gets populated when `permission.asked` events arrive and cleaned when replied.

### 7.2 Question Handling

```ts
// On question.asked event:
case "question.asked": {
  const req = event.properties as QuestionRequest
  for (const q of req.questions) {
    const rows = q.options.map((opt, i) => [{
      text: opt.label,
      callback_data: `q:${req.id}:${i}`,  // encode in string
    }])
    rows.push([{ text: "✗ Skip", callback_data: `q:${req.id}:reject` }])

    await bot.api.sendMessage(chatId, q.question, {
      reply_markup: { inline_keyboard: rows }
    })
  }
  break
}

// Callback:
if (data.startsWith("q:")) {
  const [, requestId, value] = data.split(":")
  if (value === "reject") {
    await sdk.question.reject({ id: requestId, sessionID: /* lookup */ })
  } else {
    const optionIndex = parseInt(value)
    const option = /* lookup from cached question */
    await sdk.question.reply({
      id: requestId,
      sessionID: /* lookup */,
      answers: [[option.label]],
    })
  }
  await ctx.editMessageText(`Answered: ${value === "reject" ? "skipped" : "selected"}`)
}
```

### 7.3 Abort

```ts
bot.command("cancel", async (ctx) => {
  const chatId = ctx.message.chat.id
  const chatKey = String(chatId)
  const entry = sessionManager.get(chatKey)
  if (!entry) return ctx.reply("No active session.")

  const turn = turnManager.get(entry.sessionId)
  if (!turn) return ctx.reply("Nothing running.")

  await sdk.session.abort({ sessionID: entry.sessionId })
  turnManager.end(entry.sessionId)
  await ctx.reply("Generation cancelled.")
})
```

### 7.4 Typing Indicator

```ts
// Maintain typing indicator while turn is active
function startTypingLoop(chatId: number, sessionId: string, signal: AbortSignal) {
  const send = () => {
    if (signal.aborted) return
    bot.api.sendChatAction(chatId, "typing").catch(() => {})
  }
  send()
  const interval = setInterval(send, 4000)  // Telegram typing expires after ~5s
  signal.addEventListener("abort", () => clearInterval(interval))
}

// In turn start:
const turn = turnManager.start(sessionId, chatId)
startTypingLoop(chatId, sessionId, turn.abortController.signal)
```

### 7.5 Phase 2 TDD Order

```
RED+GREEN: handlers/permissions.test.ts  → handlers/permissions.ts
RED+GREEN: handlers/questions.test.ts    → handlers/questions.ts
RED+GREEN: handlers/callback.test.ts     → handlers/callback.ts
─────────────────────────────────
bun test                                  → all unit green
E2E: phase-2.test.ts                     → real validation
```

### 7.6 Phase 2 Acceptance Criteria

- [ ] Permission request shows inline buttons (Allow/Always/Deny)
- [ ] Clicking Allow continues AI generation
- [ ] Clicking Deny stops the tool call
- [ ] Question shows options as inline buttons
- [ ] Clicking option sends reply to SDK
- [ ] `/cancel` aborts running generation
- [ ] Typing indicator active during turn
- [ ] `bun test` passes
- [ ] `bun test e2e/phase-2.test.ts` passes
- [ ] All Phase 0-1 E2E tests still pass

---

## 8. Phase 3 — Response UX

**Goal:** Make responses feel responsive and informative.

### 8.1 Draft Streaming

```ts
// When first text part arrives, send a placeholder message.
// Then edit it as more text streams in (throttled at 300-500ms).

class DraftStream {
  private messageId: number | null = null
  private lastText = ""
  private lastSentAt = 0
  private pending = ""
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private readonly throttleMs = 400

  constructor(
    private readonly bot: Bot,
    private readonly chatId: number,
    private readonly signal: AbortSignal,
  ) {
    signal.addEventListener("abort", () => this.stop())
  }

  async update(text: string) {
    if (this.stopped || !text.trim()) return
    this.pending = text

    if (!this.messageId) {
      // Send initial message
      const truncated = text.slice(0, 4096)
      const html = markdownToTelegramHtml(truncated)
      const msg = await this.bot.api.sendMessage(this.chatId, html, { parse_mode: "HTML" })
        .catch(() => null)
      if (msg) this.messageId = msg.message_id
      this.lastText = truncated
      this.lastSentAt = Date.now()
      return
    }

    this.scheduleFlush()
  }

  private scheduleFlush() {
    if (this.timer) return
    const delay = Math.max(0, this.throttleMs - (Date.now() - this.lastSentAt))
    this.timer = setTimeout(() => this.flush(), delay)
  }

  private async flush() {
    this.timer = null
    const text = this.pending.slice(0, 4096)
    if (text === this.lastText || !this.messageId) return

    const html = markdownToTelegramHtml(text)
    await this.bot.api.editMessageText(this.chatId, this.messageId, html, { parse_mode: "HTML" })
      .catch((err) => {
        if (/message is not modified/i.test(String(err))) return
        if (/can't parse entities/i.test(String(err))) {
          return this.bot.api.editMessageText(this.chatId, this.messageId!, text.slice(0, 4096))
        }
        this.stopped = true
      })
    this.lastText = text
    this.lastSentAt = Date.now()
  }

  stop() {
    this.stopped = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  getMessageId() { return this.messageId }
}
```

### 8.2 Tool Call Progress

```ts
case "message.part.updated": {
  const part = event.properties.part
  if (part.type === "tool" && part.state.status === "completed") {
    const msg = `⚙ ${part.tool}: ${part.state.title}`
    // Append to draft or send as separate message
  }
  if (part.type === "tool" && part.state.status === "running" && part.state.title) {
    // Update typing-like indicator
  }
  break
}
```

### 8.3 Final Response (after session.idle)

When `session.idle` fires:
1. Stop draft stream
2. If response exceeds 4096 chars: delete draft, send chunked final response
3. If draft message exists and final text fits: edit to final formatted version
4. Clear turn

### 8.4 Phase 3 TDD Order

```
RED+GREEN: send/draft-stream.test.ts → send/draft-stream.ts
─────────────────────────────────
bun test                              → all unit green
E2E: phase-3.test.ts                 → real validation
```

### 8.5 Phase 3 Acceptance Criteria

- [ ] Response streams via message edits (text grows over time)
- [ ] Tool call progress shown in chat
- [ ] Final response properly formatted after stream ends
- [ ] Long streamed responses get chunked correctly
- [ ] `bun test` passes
- [ ] `bun test e2e/phase-3.test.ts` passes
- [ ] All Phase 0-2 E2E tests still pass

---

## 9. Phase 4 — Session Management

### 9.1 Commands

| Command | SDK Call | Description |
|---------|----------|-------------|
| `/new` | `session.create()` | New session, clear mapping |
| `/list` | `session.list()` | Show sessions with inline keyboard |
| `/rename <title>` | `session.update({ title })` | Rename current session |
| `/delete` | `session.delete()` | Delete current session |
| `/history` | `session.messages()` | Show recent messages |
| `/summarize` | `session.summarize()` | Summarize session |
| `/info` | `session.get()` | Show session info |

### 9.2 Session Selection (inline keyboard)

```ts
bot.command("list", async (ctx) => {
  const sessions = await sdk.session.list().then(r => r.data ?? [])
  const active = sessions
    .filter(s => !s.time.archived)
    .sort((a, b) => b.time.updated - a.time.updated)
    .slice(0, 10)

  const rows = active.map(s => [{
    text: `${s.title || s.id.slice(0, 8)} (${new Date(s.time.updated).toLocaleDateString()})`,
    callback_data: `sess:${s.id.slice(0, 20)}`,  // fit in 64 bytes
  }])

  await ctx.reply("Select a session:", { reply_markup: { inline_keyboard: rows } })
})

// Callback:
if (data.startsWith("sess:")) {
  const sessionPrefix = data.slice(5)
  const sessions = await sdk.session.list().then(r => r.data ?? [])
  const match = sessions.find(s => s.id.startsWith(sessionPrefix))
  if (match) {
    sessionManager.set(chatKey, { sessionId: match.id, ... })
    await ctx.editMessageText(`Switched to: ${match.title || match.id}`)
  }
}
```

### 9.3 Phase 4 Acceptance Criteria

- [ ] `/new` creates new session and maps to chat
- [ ] `/list` shows sessions with inline keyboard
- [ ] Clicking session button switches active session
- [ ] `/rename` changes session title
- [ ] `/delete` removes session
- [ ] `/history` shows recent messages
- [ ] `bun test` passes
- [ ] `bun test e2e/phase-4.test.ts` passes
- [ ] All Phase 0-3 E2E tests still pass

---

## 10. Phase 5 — Model & Agent Selection

### 10.1 Model Selection (adapted from OpenClaw's model-buttons.ts)

```ts
bot.command("model", async (ctx) => {
  const providers = await sdk.provider.list().then(r => r.data)
  // Group models by provider
  // Show provider keyboard (2 per row)
  // On provider select → show models (paginated, 8 per page)
  // On model select → store override for this chat
  // Same callback_data pattern as OpenClaw: mdl_prov, mdl_list_X_Y, mdl_sel_X/Y, mdl_back
})
```

### 10.2 Agent Selection

```ts
bot.command("agent", async (ctx) => {
  const agents = await sdk.app.agents().then(r => r.data ?? [])
  const rows = agents.map(a => [{
    text: a.name,
    callback_data: `agent:${a.name}`,
  }])
  await ctx.reply("Select an agent:", { reply_markup: { inline_keyboard: rows } })
})
```

### 10.3 Per-Chat Overrides

Store in SessionManager (already in memory, evicted with session):
```ts
type SessionEntry = {
  sessionId: string
  directory: string
  agent?: string          // override
  model?: string          // "provider/model" override
  variant?: string        // "high" | "max" | undefined
  createdAt: number
  lastAccessAt: number
}
```

### 10.4 Phase 5 Acceptance Criteria

- [ ] `/model` shows provider list with inline keyboard
- [ ] Selecting provider shows paginated model list
- [ ] Selecting model stores override for chat
- [ ] `/agent` shows agent list with inline keyboard
- [ ] Next prompt uses selected model/agent
- [ ] `bun test` passes
- [ ] `bun test e2e/phase-5.test.ts` passes
- [ ] All Phase 0-4 E2E tests still pass

---

## 11. Phase 6 — Media & Files

### 11.1 Photo/Document → FilePartInput

```ts
async function downloadTelegramFile(ctx: Context, token: string): Promise<{
  buffer: Buffer
  mime: string
  filename: string
} | null> {
  const msg = ctx.message
  const fileRef = msg.photo?.[msg.photo.length - 1]  // highest res
    ?? msg.document
    ?? msg.audio
    ?? msg.voice
    ?? msg.video

  if (!fileRef?.file_id) return null

  const file = await ctx.api.getFile(fileRef.file_id)
  if (!file.file_path) return null

  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`
  const res = await fetch(url)
  const buffer = Buffer.from(await res.arrayBuffer())
  const mime = res.headers.get("content-type") ?? "application/octet-stream"
  const filename = (msg.document?.file_name) ?? file.file_path.split("/").pop() ?? "file"

  return { buffer, mime, filename }
}

// Convert to data URL for SDK:
function bufferToDataUrl(buffer: Buffer, mime: string): string {
  return `data:${mime};base64,${buffer.toString("base64")}`
}

// In message handler:
const media = await downloadTelegramFile(ctx, config.botToken)
if (media) {
  parts.push({
    id: generateId(),
    type: "file",
    mime: media.mime,
    url: bufferToDataUrl(media.buffer, media.mime),
    filename: media.filename,
  })
}
```

### 11.2 Voice Messages

Same download flow, but mime will be `audio/ogg` (Telegram voice format).
Can be sent as-is to OpenCode — the AI can describe audio files.

### 11.3 Phase 6 Acceptance Criteria

- [ ] Sending photo → bot processes and responds about image
- [ ] Sending document → bot processes file content
- [ ] Sending voice message → bot receives audio
- [ ] Media groups handled (multiple photos)
- [ ] `bun test` passes
- [ ] `bun test e2e/phase-6.test.ts` passes
- [ ] All Phase 0-5 E2E tests still pass

---

## 12. Phase 7 — Power Features

### 12.1 OpenCode Slash Commands

```ts
// Fetch available commands:
const commands = await sdk.command.list().then(r => r.data ?? [])

// Register as Telegram commands:
await bot.api.setMyCommands([
  ...commands.map(c => ({ command: c.name, description: c.description ?? c.name })),
  { command: "new", description: "New session" },
  { command: "cancel", description: "Cancel generation" },
  { command: "model", description: "Select model" },
  // ...
])

// Handle via session.command():
for (const cmd of commands) {
  bot.command(cmd.name, async (ctx) => {
    const args = ctx.match?.trim() ?? ""
    const entry = await sessionManager.getOrCreate(chatKey, sdk)
    await sdk.session.command({
      sessionID: entry.sessionId,
      command: cmd.name,
      arguments: args,
      agent: entry.agent ?? "build",
      model: entry.model ?? undefined,
    })
  })
}
```

### 12.2 Shell Mode

```ts
// Messages starting with ! are shell commands:
if (text.startsWith("!")) {
  const command = text.slice(1).trim()
  await sdk.session.shell({
    sessionID: entry.sessionId,
    command,
    agent: entry.agent ?? "build",
    model: { providerID: "...", modelID: "..." },
  })
  return
}
```

### 12.3 Session Features

```ts
bot.command("diff", async (ctx) => {
  const entry = sessionManager.get(chatKey)
  if (!entry) return ctx.reply("No session.")
  const diff = await sdk.session.diff({ id: entry.sessionId }).then(r => r.data)
  // Format diffs as code blocks
})

bot.command("todo", async (ctx) => {
  const entry = sessionManager.get(chatKey)
  if (!entry) return ctx.reply("No session.")
  const todos = await sdk.session.todo({ id: entry.sessionId }).then(r => r.data)
  // Format as checklist
})

bot.command("undo", async (ctx) => {
  /* session.revert() */
})

bot.command("redo", async (ctx) => {
  /* session.unrevert() */
})

bot.command("fork", async (ctx) => {
  /* session.fork() — creates new session, updates mapping */
})

bot.command("share", async (ctx) => {
  const entry = sessionManager.get(chatKey)
  const result = await sdk.session.share({ id: entry.sessionId })
  await ctx.reply(`Share URL: ${result.data.share.url}`)
})
```

### 12.4 Phase 7 Acceptance Criteria

- [ ] OpenCode slash commands appear in Telegram command menu
- [ ] `/diff` shows file changes
- [ ] `/todo` shows task list
- [ ] `/undo` reverts last change
- [ ] `!echo test` executes shell command
- [ ] `/fork` creates new session from current
- [ ] `/share` returns share URL
- [ ] `bun test` passes
- [ ] `bun test e2e/phase-7.test.ts` passes
- [ ] All Phase 0-6 E2E tests still pass

---

## 13. Phase 8 — Group & Forum

### 13.1 Group Chat

```ts
// chatKey includes thread for forums:
function buildChatKey(msg: Message): string {
  const chatId = msg.chat.id
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup"
  const isForum = msg.chat.is_forum === true
  const threadId = isForum ? (msg.message_thread_id ?? 1) : undefined

  if (isGroup && threadId != null) {
    return `${chatId}:topic:${threadId}`
  }
  return String(chatId)
}

// Mention detection:
function isBotMentioned(msg: Message, botUsername: string): boolean {
  const text = (msg.text ?? msg.caption ?? "").toLowerCase()
  if (text.includes(`@${botUsername.toLowerCase()}`)) return true
  // Also check reply to bot message
  if (msg.reply_to_message?.from?.is_bot) return true
  return false
}

// In group handler:
if (isGroup) {
  if (!isBotMentioned(msg, bot.botInfo.username)) return  // ignore non-mentions
}
```

### 13.2 Forum Topics

Each forum topic gets its own session via the chatKey that includes the topic ID.
This maps naturally to the SessionManager — each `chatId:topic:N` gets a separate session.

### 13.3 Phase 8 Acceptance Criteria

- [ ] Bot responds to @mentions in group chat
- [ ] Bot ignores non-mention messages in group
- [ ] Forum topics get separate sessions
- [ ] Different topics maintain independent conversations
- [ ] `bun test` passes
- [ ] `bun test e2e/phase-8.test.ts` passes
- [ ] All Phase 0-7 E2E tests still pass

---

## 14. Phase 9 — Infrastructure & Security

### 14.1 Webhook Mode

```ts
// Alternative to polling, for production:
import { webhookCallback } from "grammy"

const app = express()
app.post("/webhook", webhookCallback(bot, "express"))
app.get("/health", (_, res) => res.send("ok"))
app.listen(config.webhookPort)

await bot.api.setWebhook(config.webhookUrl, {
  secret_token: config.webhookSecret,
})
```

### 14.2 Access Control

```ts
// Simple allowlist:
const allowedUsers = new Set(config.allowedUserIds)

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id
  if (allowedUsers.size > 0 && (!userId || !allowedUsers.has(userId))) {
    return  // silently ignore
  }
  await next()
})
```

### 14.3 Graceful Shutdown

```ts
const shutdown = async () => {
  eventBus.stop()          // close SSE
  turnManager.abortAll()   // abort all active turns
  await bot.stop()         // stop Grammy polling
  process.exit(0)
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
```

### 14.4 Health Monitoring

```ts
// Periodic health check:
setInterval(async () => {
  const health = await sdk.global.health().then(r => r.data).catch(() => null)
  if (!health?.healthy) {
    console.error("OpenCode server unhealthy")
    // Could notify admin via Telegram
  }
}, 60_000)
```

### 14.5 Phase 9 Acceptance Criteria

- [ ] Webhook mode works as alternative to polling
- [ ] Allowlist blocks unauthorized users
- [ ] Graceful shutdown cleans up all resources
- [ ] Health monitoring detects OpenCode server issues
- [ ] `bun test` passes
- [ ] `bun test e2e/phase-9.test.ts` passes
- [ ] All Phase 0-8 E2E tests still pass (FULL REGRESSION)

---

## 15. Dependencies

```json
{
  "dependencies": {
    "grammy": "^1.x",
    "@grammyjs/runner": "^2.x",
    "@grammyjs/transformer-throttler": "^1.x",
    "@opencode-ai/sdk": "workspace:*"
  },
  "devDependencies": {
    "telegram": "^2.x",
    "@types/bun": "latest"
  }
}
```

- **grammy** — Telegram Bot Framework (same as OpenClaw)
- **@grammyjs/runner** — concurrent update processing
- **@grammyjs/transformer-throttler** — Telegram API rate limit protection
- **@opencode-ai/sdk** — OpenCode SDK client
- **telegram (gramjs)** — MTProto client for E2E tests (userbot)

---

## 16. Key Differences from OpenClaw

| Aspect | OpenClaw | Our Bot |
|--------|----------|---------|
| AI Backend | Direct agent integration | SDK HTTP client |
| Session Store | Custom file-based store | OpenCode server manages |
| Streaming | Token-by-token from agent | SSE `message.part.updated` |
| Config | OpenClaw YAML config | Simple env vars / JSON |
| Commands | Custom command registry | `command.list()` from SDK |
| Permissions | N/A (agent has full access) | Full permission system |
| Questions | N/A | Full question system |
| Multi-Project | N/A | `x-opencode-directory` header |
| Complexity | ~6,500 LOC | Target: ~2,000 LOC (Phase 1: ~500) |

---

## 17. SDK Method Quick Reference

```ts
// Session
sdk.session.create()
sdk.session.list()
sdk.session.get({ path: { id } })
sdk.session.update({ path: { id }, body: { title } })
sdk.session.delete({ path: { id } })
sdk.session.abort({ sessionID })
sdk.session.fork({ path: { id }, body: { messageID } })
sdk.session.share({ path: { id } })
sdk.session.unshare({ path: { id } })
sdk.session.prompt({ path: { id }, body: { parts, agent, model, variant, messageID } })
sdk.session.shell({ path: { id }, body: { command, agent, model } })
sdk.session.command({ path: { id }, body: { command, arguments, agent, model, variant } })
sdk.session.messages({ path: { id }, query: { cursor? } })
sdk.session.diff({ path: { id } })
sdk.session.todo({ path: { id } })
sdk.session.revert({ path: { id }, body: { messageID } })
sdk.session.unrevert({ path: { id } })
sdk.session.summarize({ path: { id } })
sdk.session.status()

// Permissions
sdk.permission.list()
sdk.permission.respond({ id, sessionID, reply })

// Questions
sdk.question.list()
sdk.question.reply({ id, sessionID, answers })
sdk.question.reject({ id, sessionID })

// Events
sdk.event.subscribe()  // per-instance SSE

// App
sdk.app.agents()
sdk.provider.list()
sdk.provider.auth()
sdk.command.list()
sdk.config.get()
sdk.global.health()
sdk.vcs.get()
```
