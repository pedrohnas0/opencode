/**
 * Model selection handlers — provider list → model list → store override.
 *
 * Exports:
 *   - parseModelCallback(data) — parse "mdl:" callback data
 *   - formatProviderList(providers) — inline keyboard of providers
 *   - formatModelList(providerID, providerName, models) — inline keyboard of models
 *   - formatCurrentModel(override?) — text showing current selection
 *   - handleModel(params) — fetch providers, return keyboard
 *   - handleModelSelect(params) — store model override in SessionEntry
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import type { SessionManager } from "../session-manager"

// --- Pure functions ---

export type ModelCallbackResult =
  | { type: "provider"; providerID: string }
  | { type: "model"; providerID: string; modelID: string }
  | { type: "back" }
  | { type: "reset" }

export function parseModelCallback(data: string): ModelCallbackResult | null {
  if (!data.startsWith("mdl:")) return null
  const rest = data.slice(4)
  if (!rest) return null

  if (rest === "back") return { type: "back" }
  if (rest === "reset") return { type: "reset" }

  // "providerID:modelID" or just "providerID"
  const firstColon = rest.indexOf(":")
  if (firstColon === -1) {
    return { type: "provider", providerID: rest }
  }

  const providerID = rest.slice(0, firstColon)
  const modelID = rest.slice(firstColon + 1)
  if (!providerID || !modelID) return null

  return { type: "model", providerID, modelID }
}

export function formatProviderList(providers: any[]): {
  text: string
  reply_markup: { inline_keyboard: any[][] }
} {
  const withModels = providers.filter(
    (p) => p.models && Object.keys(p.models).length > 0,
  )

  if (withModels.length === 0) {
    return { text: "No providers available.", reply_markup: { inline_keyboard: [] } }
  }

  const rows = withModels.map((p) => [
    { text: p.name || p.id, callback_data: `mdl:${p.id}` },
  ])

  return {
    text: "Select a provider:",
    reply_markup: { inline_keyboard: rows },
  }
}

export function formatModelList(
  providerID: string,
  providerName: string,
  models: any[],
): {
  text: string
  reply_markup: { inline_keyboard: any[][] }
} {
  const backRow = [{ text: "⬅ Back", callback_data: "mdl:back" }]

  if (models.length === 0) {
    return {
      text: `No models available for ${providerName}.`,
      reply_markup: { inline_keyboard: [backRow] },
    }
  }

  const rows = models.map((m) => [
    { text: m.name || m.id, callback_data: `mdl:${providerID}:${m.id}` },
  ])

  rows.push(backRow)

  return {
    text: `Models for ${providerName}:`,
    reply_markup: { inline_keyboard: rows },
  }
}

export function formatCurrentModel(
  override?: { providerID: string; modelID: string },
): string {
  if (!override) return "Using default model."
  return `Current model: ${override.providerID}/${override.modelID}`
}

// --- Async handlers ---

export async function handleModel(params: {
  sdk: OpencodeClient
  sessionManager: SessionManager
  chatKey: string
}): Promise<{ text: string; reply_markup: { inline_keyboard: any[][] } }> {
  const { sdk, sessionManager, chatKey } = params
  const result = await sdk.provider.list()
  const providers = (result as any).data?.all ?? []
  const entry = sessionManager.get(chatKey)
  const currentText = formatCurrentModel(entry?.modelOverride)
  const list = formatProviderList(providers)

  return {
    text: `${currentText}\n\n${list.text}`,
    reply_markup: list.reply_markup,
  }
}

export async function handleModelSelect(params: {
  chatKey: string
  providerID: string
  modelID: string
  sessionManager: SessionManager
}): Promise<string> {
  const { chatKey, providerID, modelID, sessionManager } = params
  const entry = sessionManager.get(chatKey)
  if (!entry) return "No active session."

  sessionManager.set(chatKey, {
    ...entry,
    modelOverride: { providerID, modelID },
  })

  return `Model set to: ${providerID}/${modelID}`
}
