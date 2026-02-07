/**
 * Convert Markdown text to Telegram-compatible HTML.
 *
 * Telegram supports a limited subset of HTML:
 *   <b>, <i>, <s>, <u>, <code>, <pre>, <a href="">, <blockquote>
 *
 * Strategy:
 *   1. Extract code blocks/inline code (protect from formatting)
 *   2. Escape HTML entities in remaining text
 *   3. Apply markdown → HTML conversions
 *   4. Re-insert protected code blocks
 */

const PLACEHOLDER_PREFIX = "\x00CB"
const PLACEHOLDER_INLINE = "\x00CI"

export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return ""

  // --- Step 1: Extract and protect code blocks & inline code ---
  const codeBlocks: string[] = []
  const inlineCodes: string[] = []

  // Fenced code blocks: ```lang\ncode\n```
  let text = markdown.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_, lang, code) => {
      const escaped = escapeHtml(code.replace(/\n$/, ""))
      const langAttr = lang ? ` class="language-${lang}"` : ""
      const html = `<pre><code${langAttr}>${escaped}</code></pre>`
      codeBlocks.push(html)
      return `${PLACEHOLDER_PREFIX}${codeBlocks.length - 1}\x00`
    },
  )

  // Inline code: `code`
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    const html = `<code>${escapeHtml(code)}</code>`
    inlineCodes.push(html)
    return `${PLACEHOLDER_INLINE}${inlineCodes.length - 1}\x00`
  })

  // --- Step 2: Escape HTML in remaining text ---
  text = escapeHtml(text)

  // --- Step 3: Markdown → HTML conversions ---

  // Headings: # text → <b>text</b> (Telegram has no heading tags)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")

  // Bold: **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
  text = text.replace(/__(.+?)__/g, "<b>$1</b>")

  // Italic: *text* or _text_ (but not inside words like file_name)
  text = text.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "<i>$1</i>")
  text = text.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "<i>$1</i>")

  // Strikethrough: ~~text~~
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>")

  // Links: [text](url)
  text = text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2">$1</a>',
  )

  // Blockquotes: > text
  text = text.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>")

  // --- Step 4: Re-insert protected code ---
  text = text.replace(
    new RegExp(`${escapeRegex(PLACEHOLDER_PREFIX)}(\\d+)\x00`, "g"),
    (_, idx) => codeBlocks[Number(idx)],
  )
  text = text.replace(
    new RegExp(`${escapeRegex(PLACEHOLDER_INLINE)}(\\d+)\x00`, "g"),
    (_, idx) => inlineCodes[Number(idx)],
  )

  return text
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
