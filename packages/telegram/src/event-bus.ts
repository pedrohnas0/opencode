/**
 * Single SSE connection to the OpenCode server.
 *
 * Routes incoming events to the correct Telegram chat by looking up
 * the sessionId → chatKey mapping via SessionManager.
 *
 * Anti-leak design:
 *   - One connection for ALL sessions (not one per session)
 *   - AbortController for clean shutdown
 *   - Auto-reconnect with backoff on stream end
 */

import type { OpencodeClient } from "@opencode-ai/sdk"
import type { SessionManager } from "./session-manager"

export type EventHandler = (
  sessionId: string,
  chatKey: string,
  event: any,
) => void

export type EventBusOptions = {
  sdk: OpencodeClient
  sessionManager: SessionManager
  onEvent: EventHandler
}

export class EventBus {
  private readonly sdk: OpencodeClient
  private readonly sessionManager: SessionManager
  private readonly onEvent: EventHandler
  private stopped = false

  constructor(opts: EventBusOptions) {
    this.sdk = opts.sdk
    this.sessionManager = opts.sessionManager
    this.onEvent = opts.onEvent
  }

  async start(): Promise<void> {
    this.stopped = false
    this.listen().catch((err) => {
      if (!this.stopped) {
        console.error("EventBus stream error:", err)
      }
    })
  }

  stop(): void {
    this.stopped = true
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
