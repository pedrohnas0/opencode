import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { setup, teardown, getClient, getBotUsername } from "./runner"
import {
  sendAndWait,
  assertHasButtons,
  clickAndWaitEdit,
} from "./helpers"
import { Api } from "telegram/tl"

const API_BASE = "http://127.0.0.1:4097"

describe("Phase 6.5 — Production Hardening + Bot Control API", () => {
  beforeAll(async () => {
    await setup()
  }, 90000)

  afterAll(async () => {
    await teardown()
  })

  // --- /model filtering ---

  test(
    "/model shows filtered providers (small count, not 86)",
    async () => {
      const client = getClient()
      const bot = getBotUsername()
      const reply = await sendAndWait(client, bot, "/model", 15000)
      assertHasButtons(reply)

      const markup = reply.replyMarkup as Api.ReplyInlineMarkup
      const providerCount = markup.rows.length
      // Should show only connected providers (typically 4-5, never 86)
      expect(providerCount).toBeGreaterThan(0)
      expect(providerCount).toBeLessThan(10)

      // Each button should show model count in parentheses
      const firstText = markup.rows[0].buttons[0].text
      expect(firstText).toMatch(/\(\d+\)/)
    },
    30000,
  )

  test(
    "clicking provider shows filtered models (small count per provider)",
    async () => {
      const client = getClient()
      const bot = getBotUsername()

      const providerMsg = await sendAndWait(client, bot, "/model", 15000)
      const markup = providerMsg.replyMarkup as Api.ReplyInlineMarkup
      const firstButton = markup.rows[0].buttons[0]

      const modelMsg = await clickAndWaitEdit(
        client,
        bot,
        providerMsg.id,
        firstButton.text,
      )

      const modelMarkup = modelMsg.replyMarkup as Api.ReplyInlineMarkup
      // Filtered models: should be small number (e.g. 3-5 per provider, not 22+)
      // Subtract 1 for Back button
      const modelCount = modelMarkup.rows.length - 1
      expect(modelCount).toBeGreaterThan(0)
      expect(modelCount).toBeLessThan(15)
    },
    30000,
  )

  // --- Bot Control API ---

  test(
    "GET /api/sessions returns at least 1 session after sending a message",
    async () => {
      const client = getClient()
      const bot = getBotUsername()

      // Ensure we have a session by sending a message
      await sendAndWait(client, bot, "/new", 30000)
      await sendAndWait(
        client,
        bot,
        "Respond with exactly the single word: hi",
        60000,
      )

      // Now call the Bot Control API
      const res = await fetch(`${API_BASE}/api/sessions`)
      expect(res.status).toBe(200)
      const sessions = await res.json() as any[]
      expect(sessions.length).toBeGreaterThanOrEqual(1)

      // Each session should have expected fields
      const session = sessions[0]
      expect(session.chatId).toBeDefined()
      expect(session.sessionId).toBeDefined()
    },
    120000,
  )

  test(
    "POST /api/session/:id/model changes the model override",
    async () => {
      // Get a sessionId from the API
      const sessRes = await fetch(`${API_BASE}/api/sessions`)
      const sessions = await sessRes.json() as any[]
      expect(sessions.length).toBeGreaterThan(0)
      const sessionId = sessions[0].sessionId

      // Get available models to find a valid providerID/modelID
      const modelsRes = await fetch(`${API_BASE}/api/models`)
      const providers = await modelsRes.json() as any[]
      expect(providers.length).toBeGreaterThan(0)
      const provider = providers[0]
      expect(provider.models.length).toBeGreaterThan(0)
      const model = provider.models[0]

      // Set model override
      const setRes = await fetch(`${API_BASE}/api/session/${sessionId}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerID: provider.id, modelID: model.id }),
      })
      expect(setRes.status).toBe(200)

      // Verify via GET
      const getRes = await fetch(`${API_BASE}/api/session/${sessionId}`)
      const data = await getRes.json() as any
      expect(data.model).toEqual({ providerID: provider.id, modelID: model.id })
    },
    30000,
  )

  test(
    "POST /api/session/:id/agent changes the agent override",
    async () => {
      const sessRes = await fetch(`${API_BASE}/api/sessions`)
      const sessions = await sessRes.json() as any[]
      const sessionId = sessions[0].sessionId

      // Get available agents
      const agentsRes = await fetch(`${API_BASE}/api/agents`)
      const agents = await agentsRes.json() as any[]
      expect(agents.length).toBeGreaterThan(0)
      const agentName = agents[0].name

      // Set agent override
      const setRes = await fetch(`${API_BASE}/api/session/${sessionId}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: agentName }),
      })
      expect(setRes.status).toBe(200)

      // Verify via GET
      const getRes = await fetch(`${API_BASE}/api/session/${sessionId}`)
      const data = await getRes.json() as any
      expect(data.agent).toBe(agentName)
    },
    30000,
  )

  test(
    "POST /api/session/:id/new creates a new session",
    async () => {
      const sessRes = await fetch(`${API_BASE}/api/sessions`)
      const sessions = await sessRes.json() as any[]
      const oldSessionId = sessions[0].sessionId

      // Create new session
      const newRes = await fetch(`${API_BASE}/api/session/${oldSessionId}/new`, {
        method: "POST",
      })
      expect(newRes.status).toBe(200)
      const data = await newRes.json() as any
      expect(data.sessionId).toBeDefined()
      expect(data.oldSessionId).toBe(oldSessionId)
      expect(data.sessionId).not.toBe(oldSessionId)
    },
    30000,
  )

  test(
    "GET /api/models returns providers with filtered models",
    async () => {
      const res = await fetch(`${API_BASE}/api/models`)
      expect(res.status).toBe(200)
      const providers = await res.json() as any[]
      expect(providers.length).toBeGreaterThan(0)

      // Each provider should have models
      for (const p of providers) {
        expect(p.id).toBeDefined()
        expect(p.name).toBeDefined()
        expect(p.models.length).toBeGreaterThan(0)
        // Each model should have expected fields
        for (const m of p.models) {
          expect(m.id).toBeDefined()
          expect(m.name).toBeDefined()
        }
      }
    },
    15000,
  )

  test(
    "GET /api/agents returns agents",
    async () => {
      const res = await fetch(`${API_BASE}/api/agents`)
      expect(res.status).toBe(200)
      const agents = await res.json() as any[]
      expect(agents.length).toBeGreaterThan(0)
      expect(agents[0].name).toBeDefined()
    },
    15000,
  )

  // --- regression ---

  test(
    "regression: text message works after API model/agent changes",
    async () => {
      const client = getClient()
      const bot = getBotUsername()

      const reply = await sendAndWait(
        client,
        bot,
        "Respond with exactly the single word: pong",
        60000,
      )
      expect(reply).toBeDefined()
      const text = reply.text ?? reply.message ?? ""
      expect(text.length).toBeGreaterThan(0)
    },
    120000,
  )
})
