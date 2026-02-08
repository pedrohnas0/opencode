/**
 * DraftStream — streams AI response text via Telegram message edits.
 *
 * On first text update: sends a new message (the "draft").
 * On subsequent updates: edits the draft (throttled at ~400ms).
 * On stop/abort: clears timers, no more edits.
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
  private flushing = false
  private _htmlFailed = false
  readonly throttleMs: number

  constructor(
    private readonly deps: DraftStreamDeps,
    private readonly chatId: number,
    signal: AbortSignal,
    throttleMs = 400,
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

    if (this.messageId === null) {
      // First update — send initial message
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
      return
    }

    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.timer !== null) return
    const elapsed = Date.now() - this.lastSentAt
    const delay = Math.max(0, this.throttleMs - elapsed)
    this.timer = setTimeout(() => this.flush(), delay)
  }

  private async flush(): Promise<void> {
    this.timer = null
    if (this.stopped || this.messageId === null) return

    this.flushing = true
    const text = this.pending.slice(0, 4096)

    if (text === this.lastText) {
      this.flushing = false
      return
    }

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

    // If pending changed during flush, schedule another
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
