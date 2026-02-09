/**
 * Bot Control API — Hono HTTP server exposing bot state for AI-driven control.
 *
 * Endpoints:
 *   GET  /api/sessions              — List all active sessions
 *   GET  /api/session/:sessionId    — Get session info
 *   POST /api/session/:sessionId/model — Set model override
 *   POST /api/session/:sessionId/agent — Set agent override
 *   POST /api/session/:sessionId/new   — Create new session for the chat
 *   GET  /api/models                — Connected providers + filtered models
 *   GET  /api/agents                — Available agents
 */

import { Hono } from "hono"
import type { SessionManager } from "./session-manager"
import type { TurnManager } from "./turn-manager"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { filterModels } from "./handlers/models"

export type ApiDeps = {
  sessionManager: SessionManager
  turnManager: TurnManager
  sdk: OpencodeClient
}

export function createApiApp(deps: ApiDeps) {
  const { sessionManager, turnManager, sdk } = deps

  const app = new Hono()

  app.get("/api/sessions", (c) => {
    const sessions: any[] = []
    // SessionManager doesn't expose iteration — use getBySessionId reverse map
    // We need to access internal state. Add a list method or iterate differently.
    // For now, use the approach of listing all from SDK and matching
    // Actually, let's expose what we need: all active sessions in memory
    const entries = (sessionManager as any).map as Map<string, any>
    for (const [chatKey, entry] of entries) {
      sessions.push({
        chatId: chatKey,
        sessionId: entry.sessionId,
        model: entry.modelOverride ?? null,
        agent: entry.agentOverride ?? null,
      })
    }
    return c.json(sessions)
  })

  app.get("/api/session/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId")
    const lookup = sessionManager.getBySessionId(sessionId)
    if (!lookup) {
      return c.json({ error: "Session not found" }, 404)
    }
    const turn = turnManager.get(sessionId)
    return c.json({
      chatId: lookup.chatKey,
      sessionId: lookup.entry.sessionId,
      model: lookup.entry.modelOverride ?? null,
      agent: lookup.entry.agentOverride ?? null,
      hasTurn: !!turn,
    })
  })

  app.post("/api/session/:sessionId/model", async (c) => {
    const sessionId = c.req.param("sessionId")
    const lookup = sessionManager.getBySessionId(sessionId)
    if (!lookup) {
      return c.json({ error: "Session not found" }, 404)
    }
    const body = await c.req.json()
    const { providerID, modelID } = body
    if (!providerID || !modelID) {
      return c.json({ error: "providerID and modelID are required" }, 400)
    }
    sessionManager.set(lookup.chatKey, {
      ...lookup.entry,
      modelOverride: { providerID, modelID },
    })
    return c.json({
      chatId: lookup.chatKey,
      sessionId,
      model: { providerID, modelID },
      agent: lookup.entry.agentOverride ?? null,
    })
  })

  app.post("/api/session/:sessionId/agent", async (c) => {
    const sessionId = c.req.param("sessionId")
    const lookup = sessionManager.getBySessionId(sessionId)
    if (!lookup) {
      return c.json({ error: "Session not found" }, 404)
    }
    const body = await c.req.json()
    const { agent } = body
    if (!agent) {
      return c.json({ error: "agent is required" }, 400)
    }
    sessionManager.set(lookup.chatKey, {
      ...lookup.entry,
      agentOverride: agent,
    })
    return c.json({
      chatId: lookup.chatKey,
      sessionId,
      model: lookup.entry.modelOverride ?? null,
      agent,
    })
  })

  app.post("/api/session/:sessionId/new", async (c) => {
    const sessionId = c.req.param("sessionId")
    const lookup = sessionManager.getBySessionId(sessionId)
    if (!lookup) {
      return c.json({ error: "Session not found" }, 404)
    }

    const chatKey = lookup.chatKey
    const oldOverrides = {
      modelOverride: lookup.entry.modelOverride,
      agentOverride: lookup.entry.agentOverride,
    }

    // Remove old session mapping
    sessionManager.remove(chatKey)

    // Create new session via SDK
    const result = await sdk.session.create({
      title: `Telegram ${chatKey}`,
    })
    const session = result.data!

    // Set new session with preserved overrides
    sessionManager.set(chatKey, {
      sessionId: session.id,
      directory: session.directory ?? "",
      ...oldOverrides,
    })

    return c.json({
      chatId: chatKey,
      sessionId: session.id,
      oldSessionId: sessionId,
      model: oldOverrides.modelOverride ?? null,
      agent: oldOverrides.agentOverride ?? null,
    })
  })

  app.get("/api/models", async (c) => {
    const result = await sdk.provider.list()
    const data = (result as any).data ?? {}
    const providers = data.all ?? []
    const connected = data.connected as string[] | undefined
    const defaults = data.default ?? {}

    const connectedProviders = connected
      ? providers.filter((p: any) => connected.includes(p.id))
      : providers

    const output = connectedProviders.map((p: any) => {
      const allModels = Object.values(p.models ?? {}) as any[]
      const filtered = filterModels(allModels)
      return {
        id: p.id,
        name: p.name,
        default: defaults[p.id] ?? null,
        models: filtered.map((m: any) => ({
          id: m.id,
          name: m.name,
          family: m.family ?? null,
          release_date: m.release_date ?? null,
        })),
      }
    })

    return c.json(output)
  })

  app.get("/api/agents", async (c) => {
    const result = await sdk.app.agents()
    const agents = (result as any).data ?? []
    const visible = agents.filter((a: any) => !a.hidden)
    return c.json(
      visible.map((a: any) => ({
        name: a.name,
        description: a.description ?? null,
      })),
    )
  })

  return app
}

export function createApiServer(deps: ApiDeps, port: number) {
  const app = createApiApp(deps)
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: app.fetch,
  })
}
