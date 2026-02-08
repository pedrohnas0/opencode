# Audit Report — OpenCode Telegram Bot vs OpenClaw Reference

**Date:** 2026-02-08
**Scope:** Phases 0-6 complete, comparison against OpenClaw Telegram integration (~3,500 LOC, 41 files)

---

## 1. Project Stats

| Metric | Our Bot | OpenClaw |
|--------|---------|----------|
| Source LOC | 2,580 (21 files) | ~3,500 (41 files) |
| Unit tests | 252 | ~200+ (estimated) |
| E2E tests | 32 | Manual |
| Total LOC (incl tests + E2E) | ~7,000 | ~10,000+ |
| Architecture | SDK HTTP bridge | Direct agent integration |
| Framework | Grammy | Grammy |
| Runtime | Bun | Node.js |

---

## 2. Quality Assessment by Phase

### Phases 0-4: Excellent

The core foundation is solid:
- **Anti-leak architecture** consistently applied (LRU, AbortController, bounded Maps)
- **TDD discipline** maintained — every file has colocated tests
- **EventBus** single SSE design is clean and memory-efficient
- **DraftStream** throttled editing works well
- **Permission/Question** handling with PendingRequests + inline keyboards is correct
- **Session management** with restore-on-restart is production-ready

### Phase 5 (Model & Agent Selection): Good

- Clean separation: `models.ts` (139 LOC) and `agents.ts` (93 LOC)
- Callback data fits 64-byte limit using direct IDs
- Override persistence across `/new` and session switches — properly fixed
- 28 unit tests + 9 E2E tests
- **Minor issue:** No pagination for providers with many models (deferred, acceptable)

### Phase 6 (Media & Files): Good

- Download/conversion pipeline is correct and well-tested
- MIME map is comprehensive (43 extensions)
- File size limit enforcement works
- DraftStream race condition properly fixed with `sending` flag
- 21 unit tests + 6 E2E tests (including fragmentation regression)
- **Minor issue:** `handleMedia` in bot.ts is an inline anonymous function, not exported for direct unit testing. It works via E2E tests, but differs from the pattern of other exported handlers.

---

## 3. Production Gaps (vs OpenClaw)

### Critical — Should fix before production

| # | Gap | Impact | Effort |
|---|-----|--------|--------|
| **G1** | **EventBus has no auto-reconnect** | SSE stream break = bot stops receiving events silently. No exponential backoff. | Medium |
| **G2** | **No Grammy `apiThrottler()` middleware** | Telegram API 429 rate limits not handled. Under high load, API calls fail. | Low |
| **G3** | **No `sequentialize()` middleware** | Race conditions possible if Grammy processes concurrent updates for same chat (unlikely in polling mode, but risky with webhooks). | Low |

### Important — Should fix for robustness

| # | Gap | Impact | Effort |
|---|-----|--------|--------|
| **G4** | **No error classification** | Network errors (ECONNRESET, ETIMEDOUT) not distinguished from fatal errors. All treated the same. | Medium |
| **G5** | **EventBus `listen()` doesn't retry** | If the SSE stream ends (server restart, network issue), the bot goes deaf. No automatic reconnection. | Medium |
| **G6** | **No update deduplication** | Telegram can deliver duplicate updates. We process them again. | Low |

### Nice to have — For future phases

| # | Gap | Impact | Effort |
|---|-----|--------|--------|
| G7 | No text fragment assembly | Users who paste >4096 chars get each fragment processed separately | Medium |
| G8 | No media group buffering | Multi-photo sends = N separate prompts instead of one combined | Medium |
| G9 | No inbound debouncing | Rapid messages processed individually (can flood the AI) | Low |
| G10 | No sent-message cache | Can't deduplicate outbound messages | Low |
| G11 | No update offset persistence | Bot restart may re-process recent updates | Low |

---

## 4. Code Structure Analysis

### Strengths

1. **Clean module boundaries** — Each handler file is self-contained with pure functions + async handlers
2. **Dependency injection** — `DraftStreamDeps`, `BotDeps`, SDK as params (not globals)
3. **Testability** — Every handler can be tested without Grammy context
4. **Anti-leak guarantees** — AbortController per turn, LRU bounded SessionManager, TTL on PendingRequests
5. **Session restore** — Bot survives restarts by matching "Telegram {chatId}" title pattern

### Areas for Improvement

1. **`bot.ts` is growing** (479 LOC) — Approaching the split threshold. Consider extracting:
   - Callback routing → `handlers/callbacks.ts`
   - `handleMedia` → export from `handlers/media.ts` for testability
   - `handleMessage` is already well-structured

2. **`index.ts` does too much** (283 LOC) — Event routing and `finalizeResponse` live in the entry point. Should be in a dedicated `event-router.ts` for unit testability.

3. **Event types are `any`** — EventBus uses `any` for event types. Type-safe event handling would catch bugs at compile time.

4. **No structured logging** — All errors go to `console.error`. No log levels, no structured format, no error context.

---

## 5. What We Do Better Than OpenClaw

| Aspect | Our Advantage |
|--------|--------------|
| **Architecture** | SDK bridge is thinner (~2,580 LOC vs ~3,500). Delegates AI complexity to server. |
| **Testing** | 252 unit + 32 E2E with TDD rigor. Phase-gated with full regression at each step. |
| **Memory safety** | Explicit anti-leak design: LRU, AbortController, bounded everything. |
| **Deployment** | Simple env vars (4-5 vars). No YAML config, no multi-account, no pairing system. |
| **Session management** | Server-side persistence with local LRU cache. Clean restore on restart. |
| **Phase gating** | Clear boundaries, docs per phase, regression testing. Sustainable development. |

---

## 6. Feature Parity Matrix

| Feature | Our Bot | OpenClaw | Notes |
|---------|---------|----------|-------|
| Text messages | ✅ | ✅ | |
| Photo/Document/Audio/Video | ✅ | ✅ | Phase 6 |
| Voice messages | ✅ | ✅ | |
| Streaming (edit draft) | ✅ | ✅ | With `sending` fix |
| Permissions (inline buttons) | ✅ | N/A | OpenClaw has no permission system |
| Questions (inline buttons) | ✅ | N/A | OpenClaw has no question system |
| /cancel (abort) | ✅ | ✅ | |
| Session management | ✅ | ✅ | /list, /rename, /delete, /info, /history |
| Session restore on restart | ✅ | ✅ | Title pattern matching |
| Model selection | ✅ | ✅ | Phase 5 |
| Agent selection | ✅ | N/A | OpenClaw has different agent system |
| Allowlist | ✅ | ✅ | |
| Markdown → HTML | ✅ | ✅ | |
| Message chunking | ✅ | ✅ | |
| HTML fallback | ✅ | ✅ | |
| Typing indicator | ✅ | ✅ | |
| Tool progress | ✅ | N/A | |
| Auto-reconnect SSE | ❌ | ✅ | **Gap G1/G5** |
| Rate limit middleware | ❌ | ✅ | **Gap G2** |
| Sequentialize middleware | ❌ | ✅ | **Gap G3** |
| Text fragment assembly | ❌ | ✅ | Gap G7 |
| Media group buffering | ❌ | ✅ | Gap G8 |
| Inbound debouncing | ❌ | ✅ | Gap G9 |
| Group chat support | ❌ | ✅ | Phase 8 planned |
| Forum topics | ❌ | ✅ | Phase 8 planned |
| Webhook mode | ❌ | ✅ | Phase 9 planned |
| Sticker vision cache | ❌ | ✅ | Nice to have |
| Voice → voice bubble | ❌ | ✅ | Nice to have |
| Multi-account | ❌ | ✅ | Not needed |
| Audit logging | ❌ | ✅ | Not needed |
| Update offset persistence | ❌ | ✅ | Gap G11 |

---

## 7. Recommendations

### Before Production (Priority)

1. **Fix EventBus reconnection (G1+G5)** — Add exponential backoff loop in `listen()`. When SSE stream ends or errors, wait 2s→30s (1.8x factor) and reconnect. This is the most critical gap.

2. **Add `apiThrottler()` (G2)** — One line of Grammy middleware. Prevents 429 errors.

3. **Add `sequentialize()` (G3)** — One line of Grammy middleware. Prevents per-chat race conditions (important if switching to webhooks later).

### Before Phase 7 (Recommended)

4. **Extract event routing from index.ts** — Move `onEvent` callback and `finalizeResponse` to `event-router.ts`. Enables unit testing of event logic.

5. **Type SSE events** — Replace `any` with typed event union in EventBus.

### For Future Phases

6. **Text fragment assembly (G7)** — Buffer near-limit messages for 1500ms, merge.
7. **Media group buffering (G8)** — Buffer same `media_group_id` for 200ms.
8. **Inbound debouncing (G9)** — 300-500ms buffer for rapid messages.

---

## 8. Overall Assessment

**The codebase quality is good.** Phases 5 and 6 maintained the same standards as earlier phases:
- Clean module boundaries
- Comprehensive test coverage
- Anti-leak design throughout
- Bugs found via manual testing were properly diagnosed and fixed with tests

**The main gaps are infrastructure-level** (reconnection, rate limiting, middleware), not code quality issues. These are expected at the Phase 6 stage and should be addressed in Phase 9 (Infrastructure & Security) or as a hardening pass before production deployment.

**LOC target from spec was ~2,000 for Phase 1.** At Phase 6 we're at 2,580 for all source — well within the expected trajectory toward the spec's full target.
