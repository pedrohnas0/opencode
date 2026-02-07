import { describe, test, expect, beforeEach } from "bun:test"
import { PendingRequests, type PendingEntry } from "./pending-requests"

describe("PendingRequests", () => {
  let pr: PendingRequests

  beforeEach(() => {
    pr = new PendingRequests({ maxEntries: 5, ttlMs: 1000 })
  })

  test("set() stores and get() retrieves", () => {
    const entry: PendingEntry = { type: "permission", createdAt: Date.now() }
    pr.set("req1", entry)
    expect(pr.get("req1")).toEqual(entry)
  })

  test("get() returns undefined for unknown requestID", () => {
    expect(pr.get("unknown")).toBeUndefined()
  })

  test("delete() removes entry and returns true", () => {
    pr.set("req1", { type: "permission", createdAt: Date.now() })
    expect(pr.delete("req1")).toBe(true)
    expect(pr.get("req1")).toBeUndefined()
  })

  test("delete() returns false for unknown requestID", () => {
    expect(pr.delete("unknown")).toBe(false)
  })

  test("evicts oldest when maxEntries exceeded", () => {
    for (let i = 1; i <= 6; i++) {
      pr.set(`req${i}`, { type: "permission", createdAt: Date.now() })
    }
    // req1 was evicted (oldest)
    expect(pr.get("req1")).toBeUndefined()
    // req6 still exists
    expect(pr.get("req6")).toBeDefined()
    expect(pr.size).toBe(5)
  })

  test("get() returns undefined for expired entries", async () => {
    pr.set("req1", { type: "permission", createdAt: Date.now() })
    expect(pr.get("req1")).toBeDefined()

    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 1100))
    expect(pr.get("req1")).toBeUndefined()
  })

  test("cleanup() removes all expired entries", async () => {
    pr.set("req1", { type: "permission", createdAt: Date.now() })
    pr.set("req2", { type: "question", createdAt: Date.now() })

    await new Promise((r) => setTimeout(r, 1100))

    // Add a fresh one
    pr.set("req3", { type: "permission", createdAt: Date.now() })

    pr.cleanup()
    expect(pr.size).toBe(1)
    expect(pr.get("req3")).toBeDefined()
  })
})
