/**
 * Model selection handlers — provider list → model list → store override.
 *
 * Exports:
 *   - parseModelCallback(data) — parse "mdl:" callback data
 *   - filterModels(models) — group by family, keep most recent per family
 *   - formatProviderList(providers, connected?) — inline keyboard of providers
 *   - formatModelList(providerID, providerName, models, activeModelID?) — inline keyboard of models
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

/**
 * Filter models: group by family, keep only the most recent per family.
 * Models without a family field use their id as key (no grouping).
 */
export function filterModels(models: any[]): any[] {
  const families = new Map<string, any[]>()
  for (const m of models) {
    const key = m.family || m.id
    if (!families.has(key)) families.set(key, [])
    families.get(key)!.push(m)
  }

  const filtered: any[] = []
  for (const [, members] of families) {
    if (members.length === 1) {
      filtered.push(members[0])
    } else {
      members.sort((a: any, b: any) =>
        (b.release_date ?? "").localeCompare(a.release_date ?? ""),
      )
      filtered.push(members[0])
    }
  }

  // Sort final list by release_date descending (newest first)
  filtered.sort((a: any, b: any) =>
    (b.release_date ?? "").localeCompare(a.release_date ?? ""),
  )

  return filtered
}

export function formatProviderList(
  providers: any[],
  connected?: string[],
): {
  text: string
  reply_markup: { inline_keyboard: any[][] }
} {
  // If connected list provided, filter to only those providers
  let filtered = providers
  if (connected) {
    const connSet = new Set(connected)
    filtered = providers.filter((p) => connSet.has(p.id))
  }

  const withModels = filtered.filter(
    (p) => p.models && Object.keys(p.models).length > 0,
  )

  if (withModels.length === 0) {
    return { text: "No providers available.", reply_markup: { inline_keyboard: [] } }
  }

  const rows = withModels.map((p) => {
    const modelCount = Object.keys(p.models).length
    return [
      { text: `${p.name || p.id} (${modelCount})`, callback_data: `mdl:${p.id}` },
    ]
  })

  return {
    text: "Select a provider:",
    reply_markup: { inline_keyboard: rows },
  }
}

export function formatModelList(
  providerID: string,
  providerName: string,
  models: any[],
  activeModelID?: string,
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

  const rows = models.map((m) => {
    const prefix = activeModelID && m.id === activeModelID ? "✓ " : ""
    return [
      { text: `${prefix}${m.name || m.id}`, callback_data: `mdl:${providerID}:${m.id}` },
    ]
  })

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
  const data = (result as any).data ?? {}
  const providers = data.all ?? []
  const connected = data.connected as string[] | undefined
  const entry = sessionManager.get(chatKey)
  const currentText = formatCurrentModel(entry?.modelOverride)
  const list = formatProviderList(providers, connected)

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
