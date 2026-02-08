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

## Phase 3 — Streaming + UX ✅

**Status:** Complete
**Date:** 2026-02-08

### Delivered
- **DraftStream** (`send/draft-stream.ts`): Sends initial message on first text part, then edits it as text streams in. Throttled at 400ms, HTML with plain-text fallback, auto-stop via AbortSignal.
- **Tool progress** (`send/tool-progress.ts`): Appends `⚙ Running tool: title` suffix to draft during tool execution. Cleared on next text update.
- **Final response** (`finalizeResponse` in `index.ts`): On `session.idle`, stops draft and either edits to final HTML (single chunk) or deletes draft and sends chunked messages (>4096 chars).
- **Fire-and-forget prompt** (`bot.ts`): `sdk.session.prompt()` no longer blocks the Grammy handler — the DraftStream is created before the prompt fires, so SSE events can update the draft immediately.
- **E2E project directory** (`runner.ts`): Bot now uses `/home/pedro/dev/` as OPENCODE_DIRECTORY (configurable via env), pointing to the workspace with Opus configured.

### Tests
| Type | Count | Status |
|------|-------|--------|
| Unit (bun test src/) | 137 | ✅ all pass |
| E2E Phase 0 (regression) | 2 | ✅ all pass |
| E2E Phase 1 (regression) | 3 | ✅ all pass |
| E2E Phase 2 (regression) | 3 | ✅ all pass |
| E2E Phase 3 | 4 | ✅ all pass |

### Files Created
```
src/
  send/
    draft-stream.ts                ← DraftStream class (throttled message editing)
    draft-stream.test.ts           ← 18 tests
    tool-progress.ts               ← formatToolStatus() pure function
    tool-progress.test.ts          ← 8 tests
e2e/
  phase-3.test.ts                  ← 4 E2E tests (streaming, tool progress, 2 regression)
```

### Files Modified
```
src/
  turn-manager.ts                  ← Added toolSuffix + draft fields to ActiveTurn
  turn-manager.test.ts             ← 3 new tests for new fields
  bot.ts                           ← DraftStream created before prompt, fire-and-forget prompt,
                                      draftDeps parameter for testability
  bot.test.ts                      ← Updated for fire-and-forget prompt (microtick waits)
  index.ts                         ← DraftStream updates on text/tool events, finalizeResponse
                                      on session.idle, tool progress integration
e2e/
  runner.ts                        ← OPENCODE_DIRECTORY defaults to project root (/home/pedro/dev/)
```

### Key Design Decisions
- **Fire-and-forget prompt**: `sdk.session.prompt()` was blocking Grammy's sequential handler — with Opus max, this could take minutes. Now it's fire-and-forget with `.catch()`, and the DraftStream is ready before any SSE events arrive.
- **DraftStream dependency injection**: `DraftStreamDeps` abstracts `bot.api.sendMessage/editMessageText` for testability without Grammy mocks.
- **Tool progress as suffix**: Tool status is appended to the draft text (not sent as separate messages), keeping the chat clean. Cleared when next text part arrives.
- **Finalization logic**: Single-chunk → edit draft; multi-chunk → delete draft + send chunked; no draft → send normally.

### Lessons Learned
- `sdk.session.prompt()` blocks until the server responds — with slow models this blocks Grammy's entire update processing. Fire-and-forget is essential.
- DraftStream must be created BEFORE the prompt call, not after — SSE events arrive immediately and need a target.
- E2E tests with different model configs (Opus system prompt in Portuguese) may respond differently — regression tests should assert "bot responded" not specific words.
- Chaining E2E suites with `&&` can cause server port conflicts — run each suite isolated.

---

## Phase 4 — Session Management + Hardening ✅

**Status:** Complete
**Date:** 2026-02-08
**Plan:** See `docs/plans/phase-4.md`

### Delivered
- **Allowlist middleware (N1)** — `TELEGRAM_ALLOWED_USERS` env var restricts bot access to specific Telegram user IDs. Grammy middleware at top of stack silently ignores non-allowed users. Empty list = accept all.
- **Streaming interruption fix (N2)** — `sdk.session.abort()` called before starting new turn when existing turn is active. Prevents stale SSE events from corrupting new turns. Generation counter as safety net.
- **Session restore on restart (N3)** — On startup, `sessionManager.restore(sdk)` pre-populates SessionManager with sessions matching "Telegram {chatId}" title pattern.
- **Telegram command menu (N4)** — `bot.api.setMyCommands()` registers 9 commands in Telegram's "/" autocomplete menu.
- **`/list`** — Shows sessions with inline keyboard, click `sess:` callback to switch.
- **`/rename <title>`** — Renames current session via `sdk.session.update()`.
- **`/delete`** — Deletes current session via `sdk.session.delete()` + removes SessionManager mapping.
- **`/info`** — Shows session info (title, directory, created, updated).
- **`/history`** — Shows last 10 messages (role: truncated text).
- **`/summarize`** — Returns guidance message (avoids requiring model selection).
- **`handleSessionCallback`** — Switches session via prefix matching on `session.list()`.

### Tests
| Type | Count | Status |
|------|-------|--------|
| Unit (bun test src/) | 184 | ✅ all pass |
| E2E Phase 0 (regression) | 2 | ✅ all pass |
| E2E Phase 1 (regression) | 3 | ✅ all pass |
| E2E Phase 2 (regression) | 3 | ✅ all pass |
| E2E Phase 3 (regression) | 4 | ✅ all pass |
| E2E Phase 4 | 5 | ✅ all pass |

### Files Created
```
src/
  handlers/
    allowlist.ts                   ← Grammy middleware factory
    allowlist.test.ts              ← 6 tests
    sessions.ts                    ← Session command handlers + formatting
    sessions.test.ts               ← 26 tests
e2e/
  phase-4.test.ts                  ← 5 E2E tests
```

### Files Modified
```
src/
  config.ts                        ← Added allowedUsers: number[] field
  config.test.ts                   ← 3 new tests for allowedUsers parsing
  turn-manager.ts                  ← Added generation counter to ActiveTurn
  turn-manager.test.ts             ← 3 new tests for generation field
  session-manager.ts               ← Added restore() method
  session-manager.test.ts          ← 5 new tests for restore()
  bot.ts                           ← Allowlist middleware, 6 new commands, sess: callback,
                                      sdk.session.abort() before new turn, handleSessionCallback
  bot.test.ts                      ← 4 new tests (abort behavior, session callback)
  index.ts                         ← Session restore on startup, setMyCommands registration
e2e/
  phase-3.test.ts                  ← Fixed flaky streaming assertion
```

### Lessons Learned
- `sdk.session.abort()` is fire-and-forget — errors logged but don't block new turn
- Phase 3 streaming E2E was flaky: finalizeResponse can shorten text (strips tool suffix), so assert "same message ID + has content" instead of "text grew"
- `sdk.session.summarize()` requires providerID + modelID — simpler to guide users to ask the AI directly

---

## Phase 5 — Model & Agent Selection ✅

**Status:** Complete
**Date:** 2026-02-08
**Plan:** See `docs/plans/phase-5.md`

### Delivered
- **`/model` command** — Shows providers as inline keyboard. Clicking a provider shows its models. Selecting a model stores a `modelOverride` in SessionEntry, passed to every `session.prompt()`.
- **`/agent` command** — Shows available agents (filtered: non-hidden) as inline keyboard. Selecting stores `agentOverride` in SessionEntry.
- **Model reset** — "Reset to default" button clears override.
- **Agent reset** — Same pattern.
- **Back navigation** — Model selection supports back→provider list.
- **Override persistence** — Model/agent overrides survive `/new` and session switches (`/list`).
- **Callback data encoding** — Uses `mdl:{providerID}:{modelID}` directly (fits 64-byte limit for most providers). Falls back to truncation.

### Tests
| Type | Count | Status |
|------|-------|--------|
| Unit (bun test src/) | 222 | ✅ all pass |
| E2E Phase 0-4 (regression) | 17 | ✅ all pass |
| E2E Phase 5 | 3 | ✅ all pass |

### Files Created
```
src/
  handlers/
    models.ts                      ← formatProviderList, formatModelList, parseModelCallback, handleModel, handleModelSelect
    models.test.ts                 ← 18 tests
    agents.ts                      ← formatAgentList, parseAgentCallback, handleAgent, handleAgentSelect
    agents.test.ts                 ← 10 tests
e2e/
  phase-5.test.ts                  ← 3 E2E tests
```

### Files Modified
```
src/
  session-manager.ts               ← Added modelOverride? and agentOverride? to SessionEntry
  session-manager.test.ts          ← 3 new tests for override fields
  bot.ts                           ← /model, /agent commands; mdl: + agt: callback routing;
                                      pass overrides in handleMessage prompt call
  bot.test.ts                      ← 6 new tests (override passing, callbacks)
  index.ts                         ← setMyCommands includes /model and /agent
```

### Key Design Decisions
- **Direct ID encoding in callback data** — `mdl:anthropic:claude-sonnet-4-5-20250929` fits 64 bytes. No need for index-based lookup maps.
- **Override persistence across `/new`** — overrides are per-user preferences, not per-session. Preserved by saving before remove and restoring after create.
- **Hidden agents filtered** — `sdk.app.agents()` may return hidden agents; we filter them out.
- **No pagination** — Most providers have <10 models. Deferred for later.

### Lessons Learned
- SDK v2 uses flat params: `sdk.session.prompt({ sessionID, parts, model: { providerID, modelID } })`, not nested path/body.
- `sdk.provider.list()` returns `{ data: { all: Provider[] } }` where each Provider has `models: { [modelID]: Model }`.

---

## Phase 6 — Media & Files ✅

**Status:** Complete
**Date:** 2026-02-08
**Plan:** See `docs/plans/phase-6.md`

### Delivered
- **Photo handling** — Highest resolution photo downloaded, converted to base64 data URL, sent as `FilePartInput`.
- **Document handling** — Any document type (PDF, code, text) downloaded and sent as file part. Original filename preserved.
- **Voice/Audio handling** — Voice messages (OGG) and audio files downloaded and sent as file parts.
- **Video handling** — Video files downloaded and sent as file parts.
- **Caption support** — Caption becomes `TextPartInput` alongside `FilePartInput`.
- **File size limit** — 20MB check before download (Telegram Bot API limit).
- **MIME detection** — Extension-based fallback when Telegram doesn't provide MIME type (43 extensions mapped).
- **DraftStream race condition fix** — Added `sending` flag to prevent concurrent `sendMessage` calls when multiple SSE events arrive before first message is created. Fixes fragmentation with fast models (Gemini Flash).
- **Override persistence fix** — `handleNew` and `handleSessionCallback` now preserve model/agent overrides across session changes.

### Tests
| Type | Count | Status |
|------|-------|--------|
| Unit (bun test src/) | 252 | ✅ all pass |
| E2E Phase 0-5 (regression) | 26 | ✅ all pass |
| E2E Phase 6 | 6 | ✅ all pass |

### Files Created
```
src/
  handlers/
    media.ts                       ← extractFileRef, downloadTelegramFile, bufferToDataUrl,
                                      buildFilePart, buildMediaParts, getMimeFromFileName
    media.test.ts                  ← 21 tests
e2e/
  phase-6.test.ts                  ← 6 E2E tests (photo, document, caption, regression text,
                                      fragmentation, interruption)
```

### Files Modified
```
src/
  bot.ts                           ← handleMedia function, 5 Grammy media handlers (photo,
                                      document, voice, audio, video) BEFORE message:text;
                                      handleMessage accepts optional parts param;
                                      handleNew/handleSessionCallback preserve overrides
  bot.test.ts                      ← 6 new tests (media parts, override persistence)
  send/draft-stream.ts             ← Added `sending` flag to prevent concurrent sendMessage race
  send/draft-stream.test.ts        ← 3 new tests for race condition scenarios
e2e/
  phase-5.test.ts                  ← 6 new tests (model override + persistence + E2E)
```

### Key Design Decisions
- **Grammy handler ordering** — Media handlers (`message:photo`, etc.) must come BEFORE `message:text` because photos with captions also match `message:text`.
- **Shared `handleMedia` function** — All 5 media types share the same handler logic.
- **Data URL approach** — Download → Buffer → base64 data URL. Simple, no temp files, works within HTTP body limits even for 20MB files (~27MB base64).
- **`sending` flag pattern** — Based on OpenClaw's `inFlight` pattern: first `update()` sets flag, concurrent calls just store `pending`, flag cleared after `sendMessage` completes.

### Bugs Fixed This Phase
1. **Streaming fragmentation** — With fast models (Gemini Flash), multiple SSE events called `DraftStream.update()` concurrently. All saw `messageId === null` and each called `sendMessage`, creating N separate messages. Fixed with `sending` guard flag.
2. **Model/agent override lost on `/new`** — `sessionManager.remove()` deleted the entry with overrides, then `getOrCreate()` created a clean one. Fixed by saving overrides before remove and restoring after.

### Lessons Learned
- Telegram requires valid PNG encoding — hand-crafted zlib fails, must use `zlib.deflateSync()`.
- gramjs `CustomFile(name, size, path, buffer)` for sending files in E2E tests.
- E2E fragmentation test: count bot messages between events, assert ≤ expected (not exact count).
- `DraftStream` race condition only manifests with fast models (high SSE event rate).
