import { describe, test, expect } from "bun:test"
import {
  formatQuestionMessage,
  parseQuestionCallback,
  resolveQuestionAnswer,
} from "./questions"

const sampleQuestion = {
  id: "que_abc123def456ghi789jk",
  sessionID: "ses_xyz",
  questions: [
    {
      question: "Which approach should we use?",
      header: "Approach",
      options: [
        { label: "Option A", description: "First approach" },
        { label: "Option B", description: "Second approach" },
        { label: "Option C", description: "Third approach" },
      ],
    },
  ],
}

describe("formatQuestionMessage", () => {
  test("returns question text in message", () => {
    const { text } = formatQuestionMessage(sampleQuestion)
    expect(text).toContain("Which approach should we use?")
  })

  test("renders options as 1-per-row buttons", () => {
    const { reply_markup } = formatQuestionMessage(sampleQuestion)
    const keyboard = reply_markup.inline_keyboard
    // 3 option rows + 1 skip row
    expect(keyboard.length).toBe(4)
    expect(keyboard[0][0].text).toBe("Option A")
    expect(keyboard[1][0].text).toBe("Option B")
    expect(keyboard[2][0].text).toBe("Option C")
  })

  test("adds Skip button as last row", () => {
    const { reply_markup } = formatQuestionMessage(sampleQuestion)
    const keyboard = reply_markup.inline_keyboard
    const lastRow = keyboard[keyboard.length - 1]
    expect(lastRow[0].text).toContain("Skip")
    expect(lastRow[0].callback_data).toBe(
      `q:${sampleQuestion.id}:skip`,
    )
  })

  test("callback data uses q:{requestID}:{index} format", () => {
    const { reply_markup } = formatQuestionMessage(sampleQuestion)
    const keyboard = reply_markup.inline_keyboard
    expect(keyboard[0][0].callback_data).toBe(
      `q:${sampleQuestion.id}:0`,
    )
    expect(keyboard[1][0].callback_data).toBe(
      `q:${sampleQuestion.id}:1`,
    )
    expect(keyboard[2][0].callback_data).toBe(
      `q:${sampleQuestion.id}:2`,
    )
  })
})

describe("parseQuestionCallback", () => {
  test("parses selection correctly", () => {
    const result = parseQuestionCallback("q:que_abc:0")
    expect(result).toEqual({
      requestID: "que_abc",
      action: "select",
      optionIndex: 0,
    })
  })

  test("parses skip correctly", () => {
    const result = parseQuestionCallback("q:que_abc:skip")
    expect(result).toEqual({ requestID: "que_abc", action: "skip" })
  })

  test("returns null for invalid data", () => {
    expect(parseQuestionCallback("invalid")).toBeNull()
    expect(parseQuestionCallback("perm:once:req1")).toBeNull()
    expect(parseQuestionCallback("q:")).toBeNull()
  })
})

describe("resolveQuestionAnswer", () => {
  test("maps index to option label from stored questions", () => {
    const pending = {
      type: "question" as const,
      createdAt: Date.now(),
      questions: [
        {
          options: [
            { label: "Option A" },
            { label: "Option B" },
            { label: "Option C" },
          ],
        },
      ],
    }

    expect(resolveQuestionAnswer(0, pending)).toEqual(["Option A"])
    expect(resolveQuestionAnswer(1, pending)).toEqual(["Option B"])
    expect(resolveQuestionAnswer(2, pending)).toEqual(["Option C"])
  })
})
