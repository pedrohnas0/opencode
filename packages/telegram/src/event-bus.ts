/**
 * Single SSE connection to the OpenCode server.
 *
 * Routes incoming events to the correct Telegram chat by looking up
 * the sessionId → chatKey mapping via SessionManager.
 *
 * Anti-leak design:
 *   - One connection for ALL sessions (not one per session)
 *   - AbortController for clean shutdown
 *   - Auto-reconnect with exponential backoff on stream end/error
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import type { SessionManager } from "./session-manager"

export type EventHandler = (
  sessionId: string,
  chatKey: string,
  event: any,
) => void

export type BackoffConfig = {
  initialDelayMs: number
  maxDelayMs: number
  backoffFactor: number
  jitter: number // 0-1, e.g. 0.25 for ±25%
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  initialDelayMs: 2000,
  maxDelayMs: 30000,
  backoffFactor: 1.8,
  jitter: 0.25,
}

export type EventBusOptions = {
  sdk: OpencodeClient
  sessionManager: SessionManager
  onEvent: EventHandler
  backoff?: Partial<BackoffConfig>
  /** Exposed for testing — override to track delay calls */
  _sleep?: (ms: number) => Promise<void>
}

export class EventBus {
  private readonly sdk: OpencodeClient
  private readonly sessionManager: SessionManager
  private readonly onEvent: EventHandler
  private readonly backoff: BackoffConfig
  private readonly sleep: (ms: number) => Promise<void>
  private stopped = false
  private sleepReject: ((err: Error) => void) | null = null

  constructor(opts: EventBusOptions) {
    this.sdk = opts.sdk
    this.sessionManager = opts.sessionManager
    this.onEvent = opts.onEvent
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff }
    this.sleep = opts._sleep ?? defaultSleep
  }

  async start(): Promise<void> {
    this.stopped = false
    this.reconnectLoop().catch((err) => {
      if (!this.stopped) {
        console.error("EventBus reconnect loop error:", err)
      }
    })
  }

  stop(): void {
    this.stopped = true
    // Break out of sleep if currently waiting
    if (this.sleepReject) {
      this.sleepReject(new Error("stopped"))
      this.sleepReject = null
    }
  }

  private async reconnectLoop(): Promise<void> {
    let attempt = 0

    while (!this.stopped) {
      try {
        await this.listen()
        // Stream ended normally — reset attempt counter on successful connection
        // (we got at least to the point of iterating)
      } catch (err) {
        if (this.stopped) return
        console.error(`EventBus connection error (attempt ${attempt + 1}):`, err)
      }

      if (this.stopped) return

      const delay = computeDelay(this.backoff, attempt)
      console.log(`EventBus reconnecting in ${Math.round(delay)}ms (attempt ${attempt + 1})`)

      try {
        await this.cancellableSleep(delay)
      } catch {
        // Cancelled by stop()
        return
      }

      attempt++
    }
  }

  private async cancellableSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.sleepReject = reject
      this.sleep(ms).then(() => {
        this.sleepReject = null
        resolve()
      })
    })
  }

  private async listen(): Promise<void> {
    const result = await this.sdk.event.subscribe()
    for await (const event of result.stream) {
      if (this.stopped) break

      const sessionId = extractSessionId(event)
      if (!sessionId) continue

      const lookup = this.sessionManager.getBySessionId(sessionId)
      if (!lookup) continue

      try {
        this.onEvent(sessionId, lookup.chatKey, event)
      } catch (err) {
        console.error("EventBus handler error:", err)
      }
    }
  }
}

export function computeDelay(config: BackoffConfig, attempt: number): number {
  const base = Math.min(
    config.maxDelayMs,
    config.initialDelayMs * Math.pow(config.backoffFactor, attempt),
  )
  const jitterRange = base * config.jitter
  const jitterOffset = (Math.random() * 2 - 1) * jitterRange
  return Math.max(0, base + jitterOffset)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Extract sessionID from various event shapes.
 * Events may have it at:
 *   - event.properties.part.sessionID (message.part.updated)
 *   - event.properties.info.sessionID (message.updated)
 *   - event.properties.sessionID (session.idle, session.error, etc.)
 */
function extractSessionId(event: any): string | undefined {
  const props = event?.properties
  if (!props) return undefined

  return (
    props.part?.sessionID ??
    props.info?.sessionID ??
    props.sessionID ??
    undefined
  )
}
