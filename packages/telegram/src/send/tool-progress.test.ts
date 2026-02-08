import { describe, test, expect } from "bun:test"
import { formatToolStatus } from "./tool-progress"

describe("formatToolStatus", () => {
  test("returns null for non-tool part", () => {
    expect(formatToolStatus({ type: "text", text: "hello" })).toBeNull()
  })

  test("returns running status for tool with status running and title", () => {
    const result = formatToolStatus({
      type: "tool",
      tool: "bash",
      state: { status: "running", title: "ls -la", time: { start: 1 } },
    })
    expect(result).not.toBeNull()
    expect(result).toContain("Running")
  })

  test("returns pending status for tool with status pending", () => {
    const result = formatToolStatus({
      type: "tool",
      tool: "edit",
      state: { status: "pending", input: {} },
    })
    expect(result).not.toBeNull()
    expect(result).toContain("Preparing")
  })

  test("returns null for completed tool", () => {
    expect(
      formatToolStatus({
        type: "tool",
        tool: "bash",
        state: { status: "completed", input: {}, output: "", title: "done", time: { start: 1, end: 2 } },
      }),
    ).toBeNull()
  })

  test("returns null for error tool", () => {
    expect(
      formatToolStatus({
        type: "tool",
        tool: "bash",
        state: { status: "error", input: {}, error: "fail", time: { start: 1, end: 2 } },
      }),
    ).toBeNull()
  })

  test("running status includes tool name", () => {
    const result = formatToolStatus({
      type: "tool",
      tool: "bash",
      state: { status: "running", title: "npm test", time: { start: 1 } },
    })
    expect(result).toContain("bash")
  })

  test("running status includes title text", () => {
    const result = formatToolStatus({
      type: "tool",
      tool: "bash",
      state: { status: "running", title: "npm test", time: { start: 1 } },
    })
    expect(result).toContain("npm test")
  })

  test("returns null when part.state is undefined", () => {
    expect(formatToolStatus({ type: "tool", tool: "bash" })).toBeNull()
  })
})
