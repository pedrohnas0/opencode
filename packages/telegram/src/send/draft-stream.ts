/**
 * DraftStream — streams AI response text via Telegram message edits.
 *
 * On first text update: sends a new message (the "draft").
 * On subsequent updates: edits the draft (throttled, max 1 in-flight).
 * On stop/abort: clears timers, no more edits.
 *
 * The inFlight guard ensures only ONE editMessageText call is active at a
 * time. While an edit is awaiting (possibly queued in apiThrottler's
 * Bottleneck), new SSE events just update `this.pending`. When the edit
 * completes, one new flush is scheduled with the latest text.
 *
 * Anti-leak:
 *   - AbortSignal integration (auto-stop on turn end/cancel)
 *   - No Grammy context stored — only chatId + deps
 *   - Timer tracked and cleared on stop
 */

import { markdownToTelegramHtml } from "./format"

export type DraftStreamDeps = {
  sendMessage: (
    chatId: number,
    text: string,
    opts?: { parse_mode?: string },
  ) => Promise<{ message_id: number }>
  editMessageText: (
    chatId: number,
    messageId: number,
    text: string,
    opts?: { parse_mode?: string },
  ) => Promise<unknown>
}

export class DraftStream {
  private messageId: number | null = null
  private lastText = ""
  private lastSentAt = 0
  private pending = ""
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private sending = false
  private flushing = false
  private _htmlFailed = false
  readonly throttleMs: number

  constructor(
    private readonly deps: DraftStreamDeps,
    private readonly chatId: number,
    signal: AbortSignal,
    throttleMs = 300,
  ) {
    this.throttleMs = throttleMs

    if (signal.aborted) {
      this.stopped = true
    } else {
      signal.addEventListener("abort", () => this.stop(), { once: true })
    }
  }

  async update(text: string): Promise<void> {
    if (this.stopped || !text.trim()) return
    this.pending = text

    // Guard: if already sending the initial message, just store pending.
    if (this.sending) return

    if (this.messageId === null) {
      // First call: await sendMessage to get messageId (tests depend on this)
      await this._sendInitial(text)
      return
    }

    // inFlight guard: if an edit is awaiting in apiThrottler/Telegram,
    // just schedule for later. This prevents concurrent flushes that
    // create a backlog in the Bottleneck queue.
    if (this.flushing) {
      this.scheduleFlush()
      return
    }

    // If enough time passed since last send, flush immediately
    if (!this.timer && Date.now() - this.lastSentAt >= this.throttleMs) {
      void this.flush()
      return
    }

    this.scheduleFlush()
  }

  private async _sendInitial(text: string): Promise<void> {
    this.sending = true
    const truncated = text.slice(0, 4096)
    try {
      const html = markdownToTelegramHtml(truncated)
      const msg = await this.deps.sendMessage(this.chatId, html, {
        parse_mode: "HTML",
      })
      this.messageId = msg.message_id
      this.lastText = truncated
      this.lastSentAt = Date.now()
    } catch {
      // sendMessage failed — messageId stays null
    }
    this.sending = false

    // If pending changed while we were sending, schedule a flush
    if (this.messageId !== null && this.pending.slice(0, 4096) !== this.lastText) {
      this.scheduleFlush()
    }
  }

  private scheduleFlush(): void {
    if (this.timer !== null) return
    const elapsed = Date.now() - this.lastSentAt
    const delay = Math.max(0, this.throttleMs - elapsed)
    this.timer = setTimeout(() => {
      void this.flush()
    }, delay)
  }

  private async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.stopped || this.messageId === null) return

    // inFlight guard: if already flushing, just schedule for later
    if (this.flushing) {
      this.scheduleFlush()
      return
    }

    const text = this.pending.slice(0, 4096)

    if (text === this.lastText) {
      return
    }

    this.flushing = true
    try {
      if (this._htmlFailed) {
        await this.deps.editMessageText(this.chatId, this.messageId, text)
      } else {
        const html = markdownToTelegramHtml(text)
        await this.deps.editMessageText(this.chatId, this.messageId, html, {
          parse_mode: "HTML",
        })
      }
    } catch (err) {
      const msg = String(err)

      if (/message is not modified/i.test(msg)) {
        // Ignore — text didn't actually change
      } else if (/can't parse entities/i.test(msg)) {
        this._htmlFailed = true
        // Retry as plain text
        try {
          await this.deps.editMessageText(this.chatId, this.messageId!, text)
        } catch {
          // Give up on this edit
        }
      } else if (
        /message to edit not found/i.test(msg) ||
        /MESSAGE_ID_INVALID/i.test(msg)
      ) {
        this.stopped = true
        this.flushing = false
        return
      }
      // Other errors: log and continue
    }

    this.lastText = text
    this.lastSentAt = Date.now()
    this.flushing = false

    // If pending changed during the await, schedule one more flush
    if (this.pending.slice(0, 4096) !== text) {
      this.scheduleFlush()
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  getMessageId(): number | null {
    return this.messageId
  }

  isStopped(): boolean {
    return this.stopped
  }

  hasHtmlFailed(): boolean {
    return this._htmlFailed
  }
}
