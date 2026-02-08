# Phase 3 — Streaming + UX

**Goal:** Make responses feel responsive and informative. Instead of waiting for `session.idle`
to send a single complete message, stream the response in real-time via Telegram `editMessageText`,
and show tool call progress during generation.

## What This Phase Delivers

1. **Draft Streaming** — When the first text part arrives via SSE, send a placeholder message.
   Then throttle-edit it as more text streams in (400ms minimum between edits). This replaces
   the current behavior where the bot waits for `session.idle` before sending any response.

2. **Tool Call Progress** — When `message.part.updated` events arrive with `part.type === "tool"`,
   append a status line to the draft (e.g., `\n\n---\n⚙ Running bash: ls -la`). When the tool
   completes, the status line is removed and the next text update replaces it.

3. **Final Response** — When `session.idle` fires, stop the draft stream and send the properly
   formatted final response. If the final text fits in the existing draft message (≤4096 chars),
   do a final edit. If it exceeds 4096 chars, delete the draft and send chunked final messages.

## Current Behavior vs New Behavior

**Current (Phase 1-2):**
```
User sends message
  → EventBus accumulates text parts in turn.accumulatedText
  → On session.idle: sendFormattedResponse(chatId, accumulatedText)
  → User sees nothing until the AI finishes
```

**New (Phase 3):**
```
User sends message
  → First text part arrives: DraftStream sends initial message
  → More text: DraftStream edits message (throttled at 400ms)
  → Tool starts: DraftStream appends tool status line
  → Tool completes: status line removed, text continues
  → session.idle: DraftStream stops, final formatted response sent
```

## Architecture

```
TurnManager.start()
  → Creates ActiveTurn with AbortController
  → DraftStream created in bot.ts Grammy handler after handleMessage

EventBus.onEvent("message.part.updated", type: "text")
  → turn.accumulatedText = part.text    (full text, not delta)
  → turn.toolSuffix = ""               (clear tool suffix)
  → turn.draft.update(part.text)

EventBus.onEvent("message.part.updated", type: "tool")
  → turn.toolSuffix = formatToolStatus(part)
  → turn.draft.update(turn.accumulatedText + toolSuffix)

EventBus.onEvent("session.idle")
  → turn.draft.stop()
  → Finalize: if text ≤ 4096 and draft exists:
       edit draft to final formatted HTML
     else if draft exists:
       delete draft, send chunked final
     else:
       send normally (no draft was ever sent)
  → turnManager.end(sessionId)

AbortSignal fires (turn end / cancel)
  → DraftStream.stop() auto-called via signal listener
  → All timers cleared
```

## DraftStream Class Design

```ts
// src/send/draft-stream.ts

export type DraftStreamDeps = {
  sendMessage: (chatId: number, text: string, opts?: any) => Promise<{ message_id: number }>
  editMessageText: (chatId: number, messageId: number, text: string, opts?: any) => Promise<void>
}

export class DraftStream {
  private messageId: number | null = null
  private lastText = ""
  private lastSentAt = 0
  private pending = ""
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private flushing = false
  private htmlFailed = false
  readonly throttleMs: number

  constructor(
    private readonly deps: DraftStreamDeps,
    private readonly chatId: number,
    private readonly signal: AbortSignal,
    throttleMs = 400,
  ) {
    this.throttleMs = throttleMs
    signal.addEventListener("abort", () => this.stop(), { once: true })
  }

  async update(text: string): Promise<void>
  private scheduleFlush(): void
  private async flush(): Promise<void>
  stop(): void
  getMessageId(): number | null
  isStopped(): boolean
  hasHtmlFailed(): boolean
}
```

**Key design decisions:**

1. **Dependency injection for testability** — `DraftStreamDeps` abstracts `bot.api.sendMessage`
   and `bot.api.editMessageText`. Tests inject mocks directly.

2. **Full text replacement, not delta** — SDK sends full `part.text` on each update,
   not incremental deltas. DraftStream always receives the complete current text.

3. **Truncation during streaming** — During stream, text is truncated to 4096 chars for
   the draft message. Full text is kept in `turn.accumulatedText` for final send.

4. **HTML fallback tracking** — If `editMessageText` with `parse_mode: "HTML"` fails with
   "can't parse entities", DraftStream switches to plain text for subsequent edits and sets
   `htmlFailed = true`. Finalization tries HTML one more time on the complete text.

5. **Flush mutex** — `flushing` flag prevents concurrent flush operations. If a flush is
   in flight and another `update()` arrives, the new text is stored in `pending` and will
   be picked up when the current flush completes.

6. **AbortSignal integration** — `signal.addEventListener("abort", stop, { once: true })`
   ensures automatic cleanup. No closures over Grammy context.

## DraftStream.update() Flow

```
update(text):
  if stopped or text is empty → return
  pending = text

  if no messageId yet (first update):
    truncate to 4096
    convert to HTML
    sendMessage → store messageId
    set lastText, lastSentAt
    return

  scheduleFlush()

scheduleFlush():
  if timer already set → return (will pick up latest pending)
  delay = max(0, throttleMs - (now - lastSentAt))
  timer = setTimeout(flush, delay)

flush():
  timer = null
  if stopped → return
  flushing = true
  text = pending.slice(0, 4096)
  if text === lastText → flushing = false; return

  try HTML edit:
    if htmlFailed: plain text edit instead
    else: convert to HTML, editMessageText with parse_mode: "HTML"
  catch:
    "message is not modified" → ignore
    "can't parse entities" → htmlFailed = true, retry plain text
    "MESSAGE_ID_INVALID" / "message to edit not found" → stopped = true
    other → log, continue

  lastText = text
  lastSentAt = now
  flushing = false

  if pending changed during flush (new update arrived):
    scheduleFlush()  // re-schedule with latest
```

## Tool Progress Display

Tool progress is **appended to the draft text as a suffix**, not sent as separate messages.

```ts
// src/send/tool-progress.ts

export function formatToolStatus(part: any): string | null {
  if (part.type !== "tool") return null

  const tool = part.tool ?? "tool"
  const state = part.state

  if (state?.status === "running" && state?.title) {
    return `\n\n---\n⚙ Running ${tool}: ${state.title}`
  }
  if (state?.status === "pending") {
    return `\n\n---\n⚙ Preparing ${tool}...`
  }
  // completed/error → no suffix (text will update)
  return null
}
```

## Final Response (session.idle)

```ts
async function finalizeResponse(chatId: number, turn: ActiveTurn) {
  turn.draft?.stop()
  const text = turn.accumulatedText
  if (!text) return

  const draftMsgId = turn.draft?.getMessageId() ?? null
  const html = markdownToTelegramHtml(text)
  const chunks = chunkMessage(html)

  if (chunks.length === 1 && draftMsgId) {
    // Single chunk — edit draft to final version
    try {
      await bot.api.editMessageText(chatId, draftMsgId, html, { parse_mode: "HTML" })
    } catch (err) {
      const msg = String(err)
      if (/message is not modified/i.test(msg)) return
      if (/can't parse entities/i.test(msg)) {
        await bot.api.editMessageText(chatId, draftMsgId, text.slice(0, 4096))
        return
      }
      if (/message to edit not found/i.test(msg) || /MESSAGE_ID_INVALID/i.test(msg)) {
        await sendFormattedResponse(chatId, text)
        return
      }
      throw err
    }
  } else if (draftMsgId) {
    // Multiple chunks — delete draft and send all
    await bot.api.deleteMessage(chatId, draftMsgId).catch(() => {})
    await sendFormattedResponse(chatId, text)
  } else {
    // No draft sent — send normally
    await sendFormattedResponse(chatId, text)
  }
}
```

## ActiveTurn Changes

```ts
export type ActiveTurn = {
  sessionId: string
  chatId: number
  abortController: AbortController
  accumulatedText: string
  toolSuffix: string          // NEW: current tool status suffix
  timers: Set<ReturnType<typeof setTimeout>>
  draft: DraftStream | null   // NEW: streaming draft editor
}
```

`draftMessageId` field from original spec is not needed separately — it lives on
the `DraftStream` instance via `turn.draft.getMessageId()`.

## New Files

```
src/
  send/
    draft-stream.ts              ← DraftStream class
    draft-stream.test.ts         ← ~18 tests
    tool-progress.ts             ← formatToolStatus()
    tool-progress.test.ts        ← ~8 tests
e2e/
  phase-3.test.ts                ← 3 E2E tests
```

## Modified Files

```
src/
  turn-manager.ts                ← Add toolSuffix + draft fields to ActiveTurn
  turn-manager.test.ts           ← 3 new tests for new fields
  bot.ts                         ← Create DraftStream in Grammy handler after handleMessage
  index.ts                       ← Replace accumulate-then-send with DraftStream,
                                    add tool progress, add finalizeResponse
```

## TDD Execution Order (bottom-up by dependency)

### 1. send/tool-progress.ts — Pure formatting (8 tests)

Zero dependencies. Pure function.

**Tests:**
1. Returns null for non-tool part (type: "text")
2. Returns running status for tool with status "running" and title
3. Returns pending status for tool with status "pending"
4. Returns null for completed tool (no suffix needed)
5. Returns null for error tool (no suffix needed)
6. Running status includes tool name
7. Running status includes title text
8. Returns null when part.state is undefined

### 2. send/draft-stream.ts — Core streaming class (18 tests)

Depends on: DraftStreamDeps (injected mocks).

**Tests:**

*Initial send:*
1. First update() sends a new message via sendMessage
2. First update() stores messageId from sendMessage response
3. First update() truncates text to 4096 chars
4. First update() sends HTML formatted text

*Throttled edits:*
5. Second update() schedules an edit (not immediate)
6. After throttle delay, editMessageText is called with updated text
7. Multiple rapid updates only result in one edit (latest text wins)
8. Edit uses HTML parse_mode

*Error handling:*
9. "message is not modified" error is silently ignored
10. "can't parse entities" falls back to plain text edit
11. After HTML failure, subsequent edits use plain text
12. "message to edit not found" stops the stream
13. sendMessage failure on first update → messageId stays null

*stop():*
14. stop() clears pending timer
15. After stop(), update() is a no-op
16. stop() sets isStopped() to true

*AbortSignal:*
17. Aborting signal calls stop() automatically
18. Already-aborted signal stops immediately on construction

### 3. Modified: turn-manager.ts — New fields (3 new tests)

**Changes:**
- Add `toolSuffix: string` (default `""`) and `draft: DraftStream | null` (default `null`)
- `end()` calls `turn.draft?.stop()` before abort

**New tests:**
1. New turn has toolSuffix="" and draft=null
2. Draft can be set on turn and accessed
3. end() calls draft.stop() if draft exists

### 4. Modified: bot.ts — Create DraftStream in Grammy handler

```ts
bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id
  const text = ctx.message.text.trim()
  if (!text) return

  const { turn } = await handleMessage({ chatId, text, sdk, sessionManager, turnManager })

  // Start streaming draft
  turn.draft = new DraftStream(
    {
      sendMessage: (id, t, o) => bot.api.sendMessage(id, t, o),
      editMessageText: (id, m, t, o) => bot.api.editMessageText(id, m, t, o),
    },
    chatId,
    turn.abortController.signal,
  )

  startTypingLoop(chatId, (id, action) => bot.api.sendChatAction(id, action), turn.abortController.signal)
})
```

### 5. Modified: index.ts — Wire draft updates, tool progress, finalization

**Changes to `onEvent` handler:**
- `message.part.updated` type "text": also call `turn.draft?.update(part.text)`
- `message.part.updated` type "tool": call `formatToolStatus(part)`, update draft
- `session.idle`: call `finalizeResponse()` instead of `sendFormattedResponse()`

### 6. Validate: `bun test` → all unit green (~130+ tests)

### 7. E2E: phase-3.test.ts → real validation

## E2E Tests

```ts
describe("Phase 3 — Streaming + UX", () => {
  test("response streams via message edits (text grows)", async () => {
    const client = getClient()
    const bot = getBotUsername()

    await client.sendMessage(bot, { message: "Explain what TypeScript is in 3 paragraphs" })

    // Wait for initial draft
    await sleep(3000)
    const messages1 = await client.getMessages(bot, { limit: 1 })
    const msg1 = messages1[0]
    const text1 = msg1.text ?? msg1.message ?? ""

    // Wait for more streaming
    await sleep(5000)
    const messages2 = await client.getMessages(bot, { ids: [msg1.id] })
    const msg2 = messages2[0]
    const text2 = msg2.text ?? msg2.message ?? ""

    // Same message ID (edit, not new message), text grew or stayed
    expect(msg2.id).toBe(msg1.id)
    expect(text2.length).toBeGreaterThanOrEqual(text1.length)
  }, 60000)

  test("regression: /start still works", async () => {
    const reply = await sendAndWait(getClient(), getBotUsername(), "/start")
    assertContains(reply, "OpenCode Telegram Bot")
  }, 20000)

  test("regression: text message gets AI response", async () => {
    const reply = await sendAndWait(
      getClient(), getBotUsername(),
      "Say exactly the word hello and nothing else",
      60000,
    )
    assertContains(reply, /hello/i)
  }, 90000)
})
```

**Note:** E2E streaming test is inherently timing-dependent. The test verifies core behavior
(message is edited in-place) but does not assert strict intermediate growth, since fast AI
responses may complete before the second poll.

## Edge Cases

### Race: session.idle before first text part
- `turn.accumulatedText` will be empty → `finalizeResponse` returns early
- No draft was sent, no message to clean up

### Race: DraftStream.update() and DraftStream.stop()
- `stop()` sets `stopped = true` and clears timer
- `flush()` mid-flight checks `stopped` before editing
- `update()` after `stop()` returns early

### Race: Multiple rapid text updates
- Each `update()` sets `pending` to latest text (latest-wins)
- Timer is set only once, `flush()` uses latest `pending`

### Text exceeds 4096 during streaming
- Draft truncated to 4096 chars for display
- Full text in `turn.accumulatedText` for final send
- On `session.idle`, `finalizeResponse` chunks properly

### User deletes the draft message
- `editMessageText` fails → DraftStream stops
- `finalizeResponse` tries edit, same error, falls back to `sendFormattedResponse`

### Tool progress after text
- Tool suffix appended to display only, not stored in `accumulatedText`
- Next text part clears `toolSuffix`

### HTML parse error during streaming
- DraftStream switches to plain text (`htmlFailed = true`)
- Finalization tries HTML one more time on complete text

### Turn cancelled (/cancel) during streaming
- AbortSignal fires → DraftStream.stop() auto-called
- Draft message stays in chat (partially streamed)
- No cleanup of draft message (user sees what was generated)

## Acceptance Criteria

- [ ] Response streams via message edits (text grows over time in same message)
- [ ] Tool call progress shown as status line in draft
- [ ] Final response properly formatted after stream ends (HTML)
- [ ] Long streamed responses get chunked correctly on finalize
- [ ] Streaming respects 400ms throttle between edits
- [ ] "message is not modified" errors handled silently
- [ ] "can't parse entities" falls back to plain text
- [ ] "message to edit not found" stops streaming gracefully
- [ ] AbortSignal stops draft stream automatically
- [ ] No memory leaks (timers cleared, no dangling references)
- [ ] `bun test` passes (all unit tests, including regression)
- [ ] `bun test ./e2e/phase-3.test.ts` passes
- [ ] All Phase 0-2 E2E tests still pass (regression)

## Estimated Scope

- 2 new source files + 2 test files + 1 E2E test file
- ~250-300 LOC (src) + ~350-400 LOC (tests)
- Modified: turn-manager.ts, turn-manager.test.ts, bot.ts, index.ts
