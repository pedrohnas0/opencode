/**
 * Question event → Telegram inline keyboard message.
 *
 * Pure functions:
 *   - formatQuestionMessage(event) → { text, reply_markup }
 *   - parseQuestionCallback(data) → parsed callback action
 *   - resolveQuestionAnswer(index, pending) → answer labels array
 *
 * Phase 2 MVP: handles first question only (single-select).
 */

import type { PendingEntry } from "../pending-requests"

export type QuestionOption = {
  label: string
  description: string
}

export type QuestionInfo = {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export type QuestionEvent = {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  tool?: { messageID: string; callID: string }
}

type InlineKeyboardButton = {
  text: string
  callback_data: string
}

type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][]
}

export function formatQuestionMessage(event: QuestionEvent): {
  text: string
  reply_markup: InlineKeyboardMarkup
} {
  // Phase 2 MVP: handle first question only
  const q = event.questions[0]
  const text = q.question

  const optionRows: InlineKeyboardButton[][] = q.options.map((opt, i) => [
    { text: opt.label, callback_data: `q:${event.id}:${i}` },
  ])

  // Skip button as last row
  optionRows.push([
    { text: "✗ Skip", callback_data: `q:${event.id}:skip` },
  ])

  return {
    text,
    reply_markup: { inline_keyboard: optionRows },
  }
}

export type ParsedQuestionCallback =
  | { requestID: string; action: "select"; optionIndex: number }
  | { requestID: string; action: "skip" }

export function parseQuestionCallback(
  data: string,
): ParsedQuestionCallback | null {
  if (!data.startsWith("q:")) return null

  // Format: q:{requestID}:{index|skip}
  const firstColon = data.indexOf(":")
  const lastColon = data.lastIndexOf(":")
  if (firstColon === lastColon) return null

  const requestID = data.slice(firstColon + 1, lastColon)
  const suffix = data.slice(lastColon + 1)

  if (!requestID) return null

  if (suffix === "skip") {
    return { requestID, action: "skip" }
  }

  const optionIndex = parseInt(suffix, 10)
  if (isNaN(optionIndex)) return null

  return { requestID, action: "select", optionIndex }
}

export function resolveQuestionAnswer(
  optionIndex: number,
  pending: PendingEntry,
): string[] {
  const questions = pending.questions ?? []
  const firstQuestion = questions[0]
  if (!firstQuestion) return []

  const option = firstQuestion.options[optionIndex]
  if (!option) return []

  return [option.label]
}
