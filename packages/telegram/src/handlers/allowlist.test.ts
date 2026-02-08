import { describe, test, expect, mock } from "bun:test"
import { createAllowlistMiddleware } from "./allowlist"

describe("createAllowlistMiddleware", () => {
  const createCtx = (userId?: number) => ({
    from: userId !== undefined ? { id: userId } : undefined,
  })

  test("empty allowedUsers list blocks all (safe default)", async () => {
    const mw = createAllowlistMiddleware([])
    const next = mock(() => Promise.resolve())
    await mw(createCtx(999) as any, next)
    expect(next).not.toHaveBeenCalled()
  })

  test("allowAll=true allows everyone", async () => {
    const mw = createAllowlistMiddleware([], true)
    const next = mock(() => Promise.resolve())
    await mw(createCtx(999) as any, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test("user ID in list calls next", async () => {
    const mw = createAllowlistMiddleware([111, 222])
    const next = mock(() => Promise.resolve())
    await mw(createCtx(111) as any, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test("user ID NOT in list does not call next", async () => {
    const mw = createAllowlistMiddleware([111, 222])
    const next = mock(() => Promise.resolve())
    await mw(createCtx(999) as any, next)
    expect(next).not.toHaveBeenCalled()
  })

  test("no from on context does not call next", async () => {
    const mw = createAllowlistMiddleware([111])
    const next = mock(() => Promise.resolve())
    await mw({ from: undefined } as any, next)
    expect(next).not.toHaveBeenCalled()
  })

  test("multiple users in list all allowed", async () => {
    const mw = createAllowlistMiddleware([111, 222, 333])
    for (const id of [111, 222, 333]) {
      const next = mock(() => Promise.resolve())
      await mw(createCtx(id) as any, next)
      expect(next).toHaveBeenCalledTimes(1)
    }
  })

  test("callback queries also filtered by from.id", async () => {
    const mw = createAllowlistMiddleware([111])
    const next = mock(() => Promise.resolve())
    // Callback query context still has from
    await mw({ from: { id: 999 }, callbackQuery: { data: "test" } } as any, next)
    expect(next).not.toHaveBeenCalled()
  })
})
