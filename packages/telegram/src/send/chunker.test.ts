import { describe, test, expect } from "bun:test"
import { chunkMessage } from "./chunker"

describe("chunkMessage", () => {
  test("returns empty array for empty string", () => {
    expect(chunkMessage("")).toEqual([])
  })

  test("returns single chunk for short message", () => {
    const chunks = chunkMessage("hello world")
    expect(chunks).toEqual(["hello world"])
  })

  test("returns single chunk at exactly the limit", () => {
    const text = "a".repeat(4096)
    const chunks = chunkMessage(text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(text)
  })

  test("splits long message into multiple chunks", () => {
    const text = "a".repeat(8192)
    const chunks = chunkMessage(text)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.join("")).toBe(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096)
    }
  })

  test("splits at newline boundary when possible", () => {
    // Create text where a newline appears near the split point
    const line = "x".repeat(100) + "\n"
    const text = line.repeat(50) // 50 * 101 = 5050 chars
    const chunks = chunkMessage(text)
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // Each chunk should end at a newline (except possibly the last)
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].endsWith("\n")).toBe(true)
    }
  })

  test("never splits inside an HTML tag", () => {
    // Create text with an HTML tag right at the split boundary
    const before = "a".repeat(4090)
    const tag = '<b>bold</b>'
    const after = "b".repeat(100)
    const text = before + tag + after
    const chunks = chunkMessage(text)
    // The tag should be entirely in one chunk
    const fullText = chunks.join("")
    expect(fullText).toBe(text)
    for (const chunk of chunks) {
      // No chunk should contain a partial tag (< without matching >)
      const opens = (chunk.match(/</g) || []).length
      const closes = (chunk.match(/>/g) || []).length
      expect(opens).toBe(closes)
    }
  })

  test("handles custom limit", () => {
    const text = "a".repeat(200)
    const chunks = chunkMessage(text, 100)
    expect(chunks).toHaveLength(2)
    expect(chunks[0].length).toBe(100)
    expect(chunks[1].length).toBe(100)
  })

  test("preserves all content when chunking", () => {
    const text = "Hello <b>bold</b> and <code>code</code> text ".repeat(200)
    const chunks = chunkMessage(text)
    expect(chunks.join("")).toBe(text)
  })
})
