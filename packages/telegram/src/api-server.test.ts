import { describe, test, expect, beforeEach, mock } from "bun:test"
import { createApiApp, type ApiDeps } from "./api-server"
import { SessionManager } from "./session-manager"
import { TurnManager } from "./turn-manager"

function createMockSdk() {
  return {
    provider: {
      list: mock(async () => ({
        data: {
          all: [
            {
              id: "anthropic",
              name: "Anthropic",
              models: {
                "opus-4.6": {
                  id: "opus-4.6",
                  name: "Claude Opus 4.6",
                  family: "opus",
                  release_date: "2025-12-01",
                },
                "opus-4.5": {
                  id: "opus-4.5",
                  name: "Claude Opus 4.5",
                  family: "opus",
                  release_date: "2025-09-01",
                },
                "sonnet-4.5": {
                  id: "sonnet-4.5",
                  name: "Claude Sonnet 4.5",
                  family: "sonnet",
                  release_date: "2025-09-01",
                },
              },
            },
          ],
          connected: ["anthropic"],
          default: { anthropic: "sonnet-4.5" },
        },
      })),
    },
    app: {
      agents: mock(async () => ({
        data: [
          { name: "code", description: "Coding agent" },
          { name: "build", description: "Build agent" },
          { name: "hidden-agent", description: "Secret", hidden: true },
        ],
      })),
    },
    session: {
      create: mock(async (params: any) => ({
        data: {
          id: "new-session-id",
          title: params.title,
          directory: "/tmp",
        },
      })),
    },
  }
}

function createDeps(sdkOverride?: any): { deps: ApiDeps; sm: SessionManager; tm: TurnManager } {
  const sm = new SessionManager({ maxEntries: 100, ttlMs: 60000 })
  const tm = new TurnManager()
  const sdk = sdkOverride ?? createMockSdk()
  return { deps: { sessionManager: sm, turnManager: tm, sdk: sdk as any }, sm, tm }
}

// --- Session endpoints ---

describe("GET /api/sessions", () => {
  test("returns all active sessions", async () => {
    const { deps, sm } = createDeps()
    sm.set("123", { sessionId: "s1", directory: "/tmp", modelOverride: { providerID: "anthropic", modelID: "opus" } })
    sm.set("456", { sessionId: "s2", directory: "/tmp", agentOverride: "code" })

    const app = createApiApp(deps)
    const res = await app.request("/api/sessions")
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.length).toBe(2)
    expect(data.find((s: any) => s.chatId === "123").model).toEqual({ providerID: "anthropic", modelID: "opus" })
    expect(data.find((s: any) => s.chatId === "456").agent).toBe("code")
  })

  test("returns empty array when no sessions", async () => {
    const { deps } = createDeps()
    const app = createApiApp(deps)
    const res = await app.request("/api/sessions")
    const data = await res.json()
    expect(data).toEqual([])
  })
})

describe("GET /api/session/:sessionId", () => {
  test("returns session info", async () => {
    const { deps, sm, tm } = createDeps()
    sm.set("123", {
      sessionId: "s1",
      directory: "/tmp",
      modelOverride: { providerID: "google", modelID: "gemini" },
      agentOverride: "build",
    })

    const app = createApiApp(deps)
    const res = await app.request("/api/session/s1")
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.chatId).toBe("123")
    expect(data.sessionId).toBe("s1")
    expect(data.model).toEqual({ providerID: "google", modelID: "gemini" })
    expect(data.agent).toBe("build")
    expect(data.hasTurn).toBe(false)
  })

  test("returns 404 for unknown session", async () => {
    const { deps } = createDeps()
    const app = createApiApp(deps)
    const res = await app.request("/api/session/nonexistent")
    expect(res.status).toBe(404)
  })

  test("shows hasTurn=true when turn is active", async () => {
    const { deps, sm, tm } = createDeps()
    sm.set("123", { sessionId: "s1", directory: "/tmp" })
    tm.start("s1", 123)

    const app = createApiApp(deps)
    const res = await app.request("/api/session/s1")
    const data = await res.json()
    expect(data.hasTurn).toBe(true)

    tm.end("s1")
  })
})

// --- Model/Agent override ---

describe("POST /api/session/:sessionId/model", () => {
  test("sets modelOverride in SessionManager", async () => {
    const { deps, sm } = createDeps()
    sm.set("123", { sessionId: "s1", directory: "/tmp" })

    const app = createApiApp(deps)
    const res = await app.request("/api/session/s1/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerID: "anthropic", modelID: "opus-4.6" }),
    })
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.model).toEqual({ providerID: "anthropic", modelID: "opus-4.6" })

    // Verify SessionManager was updated
    expect(sm.get("123")?.modelOverride).toEqual({ providerID: "anthropic", modelID: "opus-4.6" })
  })

  test("returns 404 for unknown session", async () => {
    const { deps } = createDeps()
    const app = createApiApp(deps)
    const res = await app.request("/api/session/nonexistent/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerID: "anthropic", modelID: "opus" }),
    })
    expect(res.status).toBe(404)
  })

  test("returns 400 when providerID or modelID missing", async () => {
    const { deps, sm } = createDeps()
    sm.set("123", { sessionId: "s1", directory: "/tmp" })

    const app = createApiApp(deps)
    const res = await app.request("/api/session/s1/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerID: "anthropic" }),
    })
    expect(res.status).toBe(400)
  })
})

describe("POST /api/session/:sessionId/agent", () => {
  test("sets agentOverride in SessionManager", async () => {
    const { deps, sm } = createDeps()
    sm.set("123", { sessionId: "s1", directory: "/tmp" })

    const app = createApiApp(deps)
    const res = await app.request("/api/session/s1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "code" }),
    })
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.agent).toBe("code")
    expect(sm.get("123")?.agentOverride).toBe("code")
  })

  test("returns 404 for unknown session", async () => {
    const { deps } = createDeps()
    const app = createApiApp(deps)
    const res = await app.request("/api/session/nonexistent/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "code" }),
    })
    expect(res.status).toBe(404)
  })

  test("returns 400 when agent missing", async () => {
    const { deps, sm } = createDeps()
    sm.set("123", { sessionId: "s1", directory: "/tmp" })

    const app = createApiApp(deps)
    const res = await app.request("/api/session/s1/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})

// --- Session management ---

describe("POST /api/session/:sessionId/new", () => {
  test("creates new session for the chat", async () => {
    const { deps, sm } = createDeps()
    sm.set("123", {
      sessionId: "old-session",
      directory: "/tmp",
      modelOverride: { providerID: "anthropic", modelID: "opus" },
      agentOverride: "code",
    })

    const app = createApiApp(deps)
    const res = await app.request("/api/session/old-session/new", {
      method: "POST",
    })
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.sessionId).toBe("new-session-id")
    expect(data.oldSessionId).toBe("old-session")
    expect(data.chatId).toBe("123")
    // Overrides should be preserved
    expect(data.model).toEqual({ providerID: "anthropic", modelID: "opus" })
    expect(data.agent).toBe("code")

    // Verify SessionManager was updated
    const entry = sm.get("123")
    expect(entry?.sessionId).toBe("new-session-id")
    expect(entry?.modelOverride).toEqual({ providerID: "anthropic", modelID: "opus" })
  })

  test("returns 404 for unknown session", async () => {
    const { deps } = createDeps()
    const app = createApiApp(deps)
    const res = await app.request("/api/session/nonexistent/new", {
      method: "POST",
    })
    expect(res.status).toBe(404)
  })
})

// --- Provider/agent listing ---

describe("GET /api/models", () => {
  test("returns connected providers with filtered models", async () => {
    const { deps } = createDeps()
    const app = createApiApp(deps)
    const res = await app.request("/api/models")
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.length).toBe(1) // Only anthropic (connected)
    expect(data[0].id).toBe("anthropic")
    expect(data[0].default).toBe("sonnet-4.5")

    // Should be filtered (opus family → only opus-4.6, sonnet family → sonnet-4.5)
    expect(data[0].models.length).toBe(2)
    const modelIds = data[0].models.map((m: any) => m.id)
    expect(modelIds).toContain("opus-4.6")
    expect(modelIds).toContain("sonnet-4.5")
    expect(modelIds).not.toContain("opus-4.5") // filtered out by filterModels
  })
})

describe("GET /api/agents", () => {
  test("returns available agents (excludes hidden)", async () => {
    const { deps } = createDeps()
    const app = createApiApp(deps)
    const res = await app.request("/api/agents")
    expect(res.status).toBe(200)

    const data = await res.json()
    expect(data.length).toBe(2) // code + build, hidden excluded
    const names = data.map((a: any) => a.name)
    expect(names).toContain("code")
    expect(names).toContain("build")
    expect(names).not.toContain("hidden-agent")
  })
})
