import { describe, test, expect } from "bun:test"
import { markdownToTelegramHtml } from "./format"

describe("markdownToTelegramHtml", () => {
  // --- HTML escaping (must happen FIRST, before any tag insertion) ---

  test("escapes & < > in plain text", () => {
    expect(markdownToTelegramHtml("A & B < C > D")).toBe(
      "A &amp; B &lt; C &gt; D",
    )
  })

  test("does not double-escape already-escaped HTML", () => {
    // Input is markdown, not HTML — so "&amp;" in markdown is literal text
    // and should be escaped to "&amp;amp;"
    expect(markdownToTelegramHtml("&amp;")).toBe("&amp;amp;")
  })

  // --- Bold ---

  test("converts **bold** to <b>", () => {
    expect(markdownToTelegramHtml("**bold**")).toBe("<b>bold</b>")
  })

  test("converts __bold__ to <b>", () => {
    expect(markdownToTelegramHtml("__bold__")).toBe("<b>bold</b>")
  })

  // --- Italic ---

  test("converts *italic* to <i>", () => {
    expect(markdownToTelegramHtml("*italic*")).toBe("<i>italic</i>")
  })

  test("converts _italic_ to <i>", () => {
    expect(markdownToTelegramHtml("_italic_")).toBe("<i>italic</i>")
  })

  // --- Strikethrough ---

  test("converts ~~strike~~ to <s>", () => {
    expect(markdownToTelegramHtml("~~strike~~")).toBe("<s>strike</s>")
  })

  // --- Inline code ---

  test("converts `code` to <code>", () => {
    expect(markdownToTelegramHtml("`code`")).toBe("<code>code</code>")
  })

  test("escapes HTML inside inline code", () => {
    expect(markdownToTelegramHtml("`<div>&</div>`")).toBe(
      "<code>&lt;div&gt;&amp;&lt;/div&gt;</code>",
    )
  })

  // --- Code blocks ---

  test("converts fenced code block without language", () => {
    expect(markdownToTelegramHtml("```\ncode\n```")).toBe(
      "<pre><code>code</code></pre>",
    )
  })

  test("converts fenced code block with language", () => {
    expect(markdownToTelegramHtml("```ts\nconst x = 1\n```")).toBe(
      '<pre><code class="language-ts">const x = 1</code></pre>',
    )
  })

  test("escapes HTML inside code blocks", () => {
    expect(markdownToTelegramHtml("```\n<div>&</div>\n```")).toBe(
      "<pre><code>&lt;div&gt;&amp;&lt;/div&gt;</code></pre>",
    )
  })

  test("preserves newlines inside code blocks", () => {
    expect(markdownToTelegramHtml("```\nline1\nline2\n```")).toBe(
      "<pre><code>line1\nline2</code></pre>",
    )
  })

  // --- Links ---

  test("converts [text](url) to <a>", () => {
    expect(markdownToTelegramHtml("[click](https://example.com)")).toBe(
      '<a href="https://example.com">click</a>',
    )
  })

  test("escapes HTML in link text", () => {
    expect(markdownToTelegramHtml("[A & B](https://example.com)")).toBe(
      '<a href="https://example.com">A &amp; B</a>',
    )
  })

  // --- Nested formatting ---

  test("handles bold + italic nested", () => {
    const result = markdownToTelegramHtml("**bold *italic***")
    expect(result).toContain("<b>")
    expect(result).toContain("<i>")
    expect(result).toContain("</b>")
  })

  // --- Edge cases ---

  test("returns empty string for empty input", () => {
    expect(markdownToTelegramHtml("")).toBe("")
  })

  test("passes through plain text unchanged (after escaping)", () => {
    expect(markdownToTelegramHtml("hello world")).toBe("hello world")
  })

  test("handles multiple paragraphs", () => {
    const result = markdownToTelegramHtml("paragraph 1\n\nparagraph 2")
    expect(result).toContain("paragraph 1")
    expect(result).toContain("paragraph 2")
  })

  // --- Headings (convert to bold since Telegram has no heading tags) ---

  test("converts headings to bold text", () => {
    const result = markdownToTelegramHtml("# Heading")
    expect(result).toContain("<b>Heading</b>")
  })

  // --- Lists ---

  test("preserves bullet list formatting", () => {
    const result = markdownToTelegramHtml("- item 1\n- item 2")
    expect(result).toContain("item 1")
    expect(result).toContain("item 2")
  })

  // --- Blockquotes ---

  test("converts blockquotes", () => {
    const result = markdownToTelegramHtml("> quoted text")
    expect(result).toContain("quoted text")
  })
})
