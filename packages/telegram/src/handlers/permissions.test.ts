import { describe, test, expect } from "bun:test"
import {
  formatPermissionMessage,
  parsePermissionCallback,
} from "./permissions"

const samplePermission = {
  id: "per_abc123def456ghi789jk",
  sessionID: "ses_xyz",
  permission: "bash",
  patterns: ["rm -rf /tmp/test"],
  metadata: {},
  always: ["bash:*"],
}

describe("formatPermissionMessage", () => {
  test("text contains permission name", () => {
    const { text } = formatPermissionMessage(samplePermission)
    expect(text).toContain("bash")
  })

  test("text contains patterns", () => {
    const { text } = formatPermissionMessage(samplePermission)
    expect(text).toContain("rm -rf /tmp/test")
  })

  test("returns keyboard with 3 buttons", () => {
    const { reply_markup } = formatPermissionMessage(samplePermission)
    const buttons = reply_markup.inline_keyboard[0]
    expect(buttons).toHaveLength(3)
    expect(buttons[0].text).toContain("Allow")
    expect(buttons[1].text).toContain("Always")
    expect(buttons[2].text).toContain("Deny")
  })

  test("callback data follows perm:{action}:{requestID} pattern", () => {
    const { reply_markup } = formatPermissionMessage(samplePermission)
    const buttons = reply_markup.inline_keyboard[0]
    expect(buttons[0].callback_data).toBe(
      `perm:once:${samplePermission.id}`,
    )
    expect(buttons[1].callback_data).toBe(
      `perm:always:${samplePermission.id}`,
    )
    expect(buttons[2].callback_data).toBe(
      `perm:deny:${samplePermission.id}`,
    )
  })
})

describe("parsePermissionCallback", () => {
  test("parses perm:once correctly", () => {
    const result = parsePermissionCallback("perm:once:per_abc123")
    expect(result).toEqual({ requestID: "per_abc123", reply: "once" })
  })

  test("parses perm:always correctly", () => {
    const result = parsePermissionCallback("perm:always:per_abc123")
    expect(result).toEqual({ requestID: "per_abc123", reply: "always" })
  })

  test("parses perm:deny as reject", () => {
    const result = parsePermissionCallback("perm:deny:per_abc123")
    expect(result).toEqual({ requestID: "per_abc123", reply: "reject" })
  })

  test("returns null for invalid data", () => {
    expect(parsePermissionCallback("invalid:data")).toBeNull()
    expect(parsePermissionCallback("q:req1:0")).toBeNull()
    expect(parsePermissionCallback("perm:unknown:req1")).toBeNull()
  })
})
