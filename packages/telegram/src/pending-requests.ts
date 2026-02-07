/**
 * Bounded Map<requestID, PendingEntry> with TTL.
 *
 * Stores pending permission and question requests so that:
 * - Questions can resolve option index → label when callback is clicked
 * - Double-click protection (delete on first use)
 * - TTL expiry guard (stale buttons get "expired" message)
 *
 * Anti-leak: bounded by maxEntries + TTL cleanup.
 */

export type PendingEntry = {
  type: "permission" | "question"
  createdAt: number
  questions?: Array<{ options: Array<{ label: string }> }>
}

export type PendingRequestsOptions = {
  maxEntries: number
  ttlMs: number
}

export class PendingRequests {
  private map = new Map<string, PendingEntry>()
  private readonly maxEntries: number
  private readonly ttlMs: number

  constructor(opts: PendingRequestsOptions) {
    this.maxEntries = opts.maxEntries
    this.ttlMs = opts.ttlMs
  }

  set(requestID: string, entry: PendingEntry): void {
    // Evict oldest if at capacity
    while (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) {
        this.map.delete(oldest)
      }
    }
    this.map.set(requestID, entry)
  }

  get(requestID: string): PendingEntry | undefined {
    const entry = this.map.get(requestID)
    if (!entry) return undefined

    // Check TTL
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.map.delete(requestID)
      return undefined
    }

    return entry
  }

  delete(requestID: string): boolean {
    return this.map.delete(requestID)
  }

  cleanup(): void {
    const now = Date.now()
    for (const [id, entry] of this.map) {
      if (now - entry.createdAt > this.ttlMs) {
        this.map.delete(id)
      }
    }
  }

  get size(): number {
    return this.map.size
  }
}
