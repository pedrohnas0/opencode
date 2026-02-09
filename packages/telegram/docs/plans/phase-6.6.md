# Phase 6.6 — DraftStream Fix (inFlight Guard)

**Goal:** Fix the streaming bottleneck where DraftStream creates concurrent
flushes that queue in apiThrottler's Bottleneck, causing a 609-char response
to take 69 seconds instead of ~4 seconds.

## Root Cause

DraftStream's `flush()` is async (awaits `editMessageText` which blocks in
apiThrottler's Bottleneck queue). While one flush is blocked, `update()` calls
`scheduleFlush()` which only checks `this.timer` (null because flush cleared
it). This creates NEW concurrent flushes, each adding a job to the Bottleneck
queue. With SSE events every ~25ms, a 3-second AI response generates 67
concurrent Bottleneck jobs that drain at 1/second = 69 seconds total.

**Evidence from logs:**
```
AI finished at +4329ms (session.idle)
edit#67 DONE at +69399ms  ← 65 SECONDS after AI finished
```

## Reference: OpenClaw Pattern

OpenClaw's DraftStream solves this with an `inFlight` guard:

```ts
// flush() — only one API call in flight at a time
if (inFlight) { schedule(); return; }
inFlight = true;
try { await sendDraft(text); } finally { inFlight = false; }
if (pendingText) { schedule(); }

// update() — if in-flight, just store pending + schedule
pendingText = text;
if (inFlight) { schedule(); return; }
```

Result: max 1 Bottleneck job at a time. Each edit carries the latest text.

## What This Phase Delivers

1. **`inFlight` guard in DraftStream** — Prevents concurrent flushes. While
   one edit is awaiting in apiThrottler/Telegram, new SSE events only update
   `this.pending`. When the edit completes, one new flush is scheduled with
   the latest text.

2. **Remove debug logs** — Clean up the `[DS ...]` console.logs added during
   investigation.

3. **Revert throttleMs to 400ms** — The throttle was temporarily changed to
   1000ms for testing. With the inFlight guard, 400ms is fine because
   apiThrottler's `minTime: 1000ms` is the effective rate limiter. The 400ms
   just ensures we don't wait unnecessarily when apiThrottler is ready.

---

## Implementation Detail

### Current (broken) flow:

```
SSE event → update() → scheduleFlush() → flush() → await editMessageText
                                                      ↑ blocks in Bottleneck
SSE event → update() → scheduleFlush() → flush() → await editMessageText ← NEW JOB
SSE event → update() → scheduleFlush() → flush() → await editMessageText ← NEW JOB
(67 jobs pile up in Bottleneck queue)
```

### Fixed flow:

```
SSE event → update() → flush() → inFlight=true → await editMessageText
SSE event → update() → inFlight? YES → schedule() → (timer guards against dup)
SSE event → update() → inFlight? YES → schedule() → (timer exists, skip)
...
edit completes → inFlight=false → pendingText changed? → schedule()
timer fires → flush() → inFlight=true → await editMessageText (with LATEST text)
```

### Changes to `update()`:

```ts
// Before: async (awaits sendMessage on first call)
// After: match OpenClaw — sync for subsequent calls, only first call is async

update(text: string): void {  // ← sync return (fire-and-forget)
  if (this.stopped || !text.trim()) return
  this.pending = text

  if (this.sending) return  // guard for initial sendMessage (existing)

  if (this.messageId === null) {
    // First call: send initial message (async, fire-and-forget)
    this._sendInitial(text)
    return
  }

  if (this.flushing) {
    this.scheduleFlush()  // ← NEW: if in-flight, just schedule
    return
  }

  // If enough time passed since last send, flush immediately
  if (!this.timer && Date.now() - this.lastSentAt >= this.throttleMs) {
    void this.flush()
    return
  }

  this.scheduleFlush()
}
```

### Changes to `flush()`:

```ts
private async flush(): Promise<void> {
  this.timer = null
  if (this.stopped || this.messageId === null) return

  if (this.flushing) {       // ← NEW guard
    this.scheduleFlush()
    return
  }

  const text = this.pending.slice(0, 4096)
  if (text === this.lastText) return

  this.flushing = true        // ← existing flag, now used as guard
  try {
    await editMessageText(...)
  } catch { ... }
  finally {
    this.flushing = false     // ← always release
  }

  this.lastText = text
  this.lastSentAt = Date.now()

  if (this.pending.slice(0, 4096) !== text) {
    this.scheduleFlush()      // ← if text changed during await, schedule one more
  }
}
```

---

## Modified Files

```
src/
  send/draft-stream.ts       ← Add inFlight guard, remove debug logs, revert throttle
  send/draft-stream.test.ts  ← Add tests for inFlight behavior
  index.ts                   ← Remove debug logs from finalizeResponse/eventBus
```

## TDD Execution Order

### A1. DraftStream inFlight guard (6-8 new tests)

**File:** `src/send/draft-stream.ts` + `src/send/draft-stream.test.ts`

**Tests:**

*inFlight guard:*
1. While edit is in-flight, update() does not call editMessageText again
2. After in-flight edit completes, pending text is flushed with latest value
3. Multiple updates during in-flight result in single edit with final text
4. flush() checks flushing flag — returns early if already flushing

*Timing:*
5. Immediate flush when throttleMs elapsed since last send
6. Scheduled flush when within throttle window

*Stop behavior:*
7. stop() during in-flight prevents subsequent flushes

### B2. Remove debug logs

**Files:** `src/send/draft-stream.ts`, `src/index.ts`

Remove all `console.log("[DS ...")` and `console.log("[EVENT]")` and
`console.log("[FINALIZE]")` debug lines.

### C3. Manual test

Start dev bot, send message, verify logs show ~3-5 edits (not 67).

---

## Acceptance Criteria

- [ ] DraftStream never has more than 1 editMessageText call in-flight
- [ ] Each edit carries the latest accumulated text (no stale snapshots)
- [ ] A 3-second Haiku response completes visible streaming in ~5s (not 69s)
- [ ] `bun test src/` passes (all unit tests including new ones)
- [ ] Manual test with dev bot confirms fix

## Estimated Scope

- ~30 LOC changed in draft-stream.ts (guard logic)
- ~20 LOC removed (debug logs)
- ~60-80 LOC new tests
- 0 new files, 0 new dependencies
