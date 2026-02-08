/**
 * LRU-bounded session map: Telegram chatKey ↔ OpenCode sessionId.
 *
 * Anti-leak design:
 *   - Max entries cap (evicts oldest on overflow)
 *   - TTL-based expiration (cleanup removes stale entries)
 *   - Reverse map (sessionId → chatKey) for SSE event routing
 *   - Eviction only removes from memory — sessions persist on OpenCode server
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2"

export type SessionEntry = {
  sessionId: string
  directory: string
  createdAt: number
  lastAccessAt: number
  modelOverride?: { providerID: string; modelID: string }
  agentOverride?: string
}

export type SessionManagerOptions = {
  maxEntries: number
  ttlMs: number
}

export class SessionManager {
  private map = new Map<string, SessionEntry>()
  private reverseMap = new Map<string, string>() // sessionId → chatKey
  private readonly maxEntries: number
  private readonly ttlMs: number

  constructor(opts: SessionManagerOptions) {
    this.maxEntries = opts.maxEntries
    this.ttlMs = opts.ttlMs
  }

  async getOrCreate(
    chatKey: string,
    sdk: OpencodeClient,
  ): Promise<SessionEntry> {
    const existing = this.map.get(chatKey)
    if (existing) {
      // LRU: refresh access order by re-inserting
      this.map.delete(chatKey)
      existing.lastAccessAt = Date.now()
      this.map.set(chatKey, existing)
      return existing
    }

    // Create new session via SDK
    const result = await sdk.session.create({
      title: `Telegram ${chatKey}`,
    })

    const session = result.data!
    const entry: SessionEntry = {
      sessionId: session.id,
      directory: session.directory ?? "",
      createdAt: Date.now(),
      lastAccessAt: Date.now(),
    }

    this.insert(chatKey, entry)
    return entry
  }

  get(chatKey: string): SessionEntry | undefined {
    return this.map.get(chatKey)
  }

  getBySessionId(
    sessionId: string,
  ): { chatKey: string; entry: SessionEntry } | undefined {
    const chatKey = this.reverseMap.get(sessionId)
    if (!chatKey) return undefined
    const entry = this.map.get(chatKey)
    if (!entry) return undefined
    return { chatKey, entry }
  }

  set(
    chatKey: string,
    init: {
      sessionId: string
      directory: string
      modelOverride?: { providerID: string; modelID: string }
      agentOverride?: string
    },
  ): void {
    // Clean up old binding if exists
    const old = this.map.get(chatKey)
    if (old) {
      this.reverseMap.delete(old.sessionId)
    }

    const entry: SessionEntry = {
      sessionId: init.sessionId,
      directory: init.directory,
      createdAt: Date.now(),
      lastAccessAt: Date.now(),
      modelOverride: init.modelOverride,
      agentOverride: init.agentOverride,
    }

    this.insert(chatKey, entry)
  }

  remove(chatKey: string): void {
    const entry = this.map.get(chatKey)
    if (entry) {
      this.reverseMap.delete(entry.sessionId)
      this.map.delete(chatKey)
    }
  }

  async restore(sdk: OpencodeClient): Promise<number> {
    const result = await sdk.session.list()
    const sessions = (result as any).data ?? []
    let restored = 0

    for (const session of sessions) {
      if (session.time?.archived) continue
      const match = session.title?.match(/^Telegram (\d+)$/)
      if (!match) continue

      const chatKey = match[1]
      if (!this.get(chatKey)) {
        this.set(chatKey, {
          sessionId: session.id,
          directory: session.directory ?? "",
        })
        restored++
      }
    }

    return restored
  }

  cleanup(): void {
    const now = Date.now()
    for (const [chatKey, entry] of this.map) {
      if (now - entry.lastAccessAt > this.ttlMs) {
        this.reverseMap.delete(entry.sessionId)
        this.map.delete(chatKey)
      }
    }
  }

  get size(): number {
    return this.map.size
  }

  private insert(chatKey: string, entry: SessionEntry): void {
    // Remove old binding for this chatKey
    const old = this.map.get(chatKey)
    if (old) {
      this.reverseMap.delete(old.sessionId)
      this.map.delete(chatKey)
    }

    // Evict oldest if at capacity
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) {
        const evicted = this.map.get(oldest)
        if (evicted) this.reverseMap.delete(evicted.sessionId)
        this.map.delete(oldest)
      }
    }

    this.map.set(chatKey, entry)
    this.reverseMap.set(entry.sessionId, chatKey)
  }
}
