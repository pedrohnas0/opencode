# Phase 6 — Media & Files

**Goal:** Accept photos, documents, audio, voice messages, and video from Telegram
users, download them, convert to data URLs, and send as `FilePartInput` alongside
text to the OpenCode SDK. This allows the AI to process images, read documents,
and receive audio/video files.

## What This Phase Delivers

1. **Photo handling** — Photos sent to the bot are downloaded (highest resolution),
   converted to a base64 data URL, and sent as a `FilePartInput` part to the SDK.

2. **Document handling** — Documents (PDF, code files, etc.) are downloaded and
   sent the same way. The original filename is preserved.

3. **Voice/Audio handling** — Voice messages (OGG) and audio files are downloaded
   and sent as file parts.

4. **Video handling** — Video files are downloaded and sent as file parts.

5. **Caption support** — If a media message has a caption, it becomes the text part.
   If no caption, only the file part is sent.

6. **Media groups** — When a user sends multiple photos at once, each is processed
   individually (Grammy delivers them as separate updates).

7. **File size limit** — Telegram Bot API limits file downloads to 20MB. Files
   exceeding this are rejected with a user-friendly message.

## SDK Integration

The SDK `session.prompt()` accepts mixed part arrays:

```ts
sdk.session.prompt({
  sessionID: string,
  parts: [
    { type: "text", text: "What's in this image?" },
    { type: "file", mime: "image/jpeg", url: "data:image/jpeg;base64,...", filename: "photo.jpg" },
  ],
})
```

`FilePartInput` type (from SDK v2):
```ts
type FilePartInput = {
  id?: string
  type: "file"
  mime: string
  filename?: string
  url: string        // data URL: "data:{mime};base64,{base64data}"
  source?: FilePartSource
}
```

## Architecture

### Download Flow

```
User sends photo/document/voice/audio/video
  → Grammy filter: bot.on("message:photo") / bot.on("message:document") / etc.
  → downloadTelegramFile(fileId, token)
    → ctx.api.getFile(fileId) → file_path
    → fetch("https://api.telegram.org/file/bot{token}/{file_path}")
    → Buffer.from(arrayBuffer)
    → return { buffer, mime, filename }
  → bufferToDataUrl(buffer, mime)
    → "data:{mime};base64,{base64}"
  → Build parts array: [FilePartInput, TextPartInput?]
  → handleMessage({ chatId, text, parts, sdk, ... })
```

### Grammy Handlers

```
bot.on("message:photo", handler)       ← Photo (pick highest res from photo array)
bot.on("message:document", handler)    ← Document (any file type)
bot.on("message:voice", handler)       ← Voice message (OGG)
bot.on("message:audio", handler)       ← Audio file
bot.on("message:video", handler)       ← Video file
bot.on("message:text", handler)        ← Text-only (existing — unchanged)
```

All media handlers share the same logic pattern, consolidated into a single
`handleMediaMessage` function.

### handleMessage Changes

Currently `handleMessage` accepts `text: string` and builds
`parts: [{ type: "text", text }]`. This needs to be generalized to accept
an optional pre-built `parts` array.

```
BEFORE:
  handleMessage({ chatId, text, sdk, ... })
    → parts = [{ type: "text", text }]
    → sdk.session.prompt({ parts, ... })

AFTER:
  handleMessage({ chatId, text, parts?, sdk, ... })
    → if parts provided: use them directly
    → else: parts = [{ type: "text", text }]
    → sdk.session.prompt({ parts, ... })
```

## New Files

```
src/
  handlers/
    media.ts                     ← downloadTelegramFile, bufferToDataUrl,
                                   buildMediaParts, handleMediaMessage
    media.test.ts                ← ~18 tests
e2e/
  phase-6.test.ts                ← 3-4 E2E tests
```

## Modified Files

```
src/
  bot.ts                         ← Add media Grammy handlers (photo, document,
                                   voice, audio, video), generalize handleMessage
                                   to accept optional parts array
  bot.test.ts                    ← ~4 new tests for parts passthrough
```

## TDD Execution Order (bottom-up by dependency)

### Group A — Pure Functions (Independent)

#### A1. handlers/media.ts — File download & conversion (18 tests)

**Pure functions:**

```ts
bufferToDataUrl(buffer: Buffer, mime: string): string
// → "data:{mime};base64,{base64data}"

buildFilePart(params: { buffer: Buffer; mime: string; filename: string }): FilePartInput
// → { type: "file", mime, url: dataUrl, filename }

buildMediaParts(params: {
  buffer: Buffer
  mime: string
  filename: string
  caption?: string
}): Array<TextPartInput | FilePartInput>
// → [FilePartInput] or [TextPartInput, FilePartInput] if caption exists

getMimeFromFileName(filename: string): string
// → Fallback MIME type from extension when Telegram doesn't provide one

extractFileRef(msg: TelegramMessage): { fileId: string; filename?: string; mime?: string } | null
// → Extract file_id and metadata from photo/document/voice/audio/video
```

**Async functions:**

```ts
downloadTelegramFile(params: {
  fileId: string
  token: string
  getFile: (fileId: string) => Promise<{ file_path?: string; file_size?: number }>
}): Promise<{ buffer: Buffer; mime: string; filename: string } | null>
// → Downloads file from Telegram API, returns buffer + metadata
// → Returns null if file_path missing or download fails
// → Checks file_size against 20MB limit
```

**Tests:**

*bufferToDataUrl:*
1. Converts buffer to correct data URL format
2. Handles empty buffer
3. Handles different MIME types (image/jpeg, application/pdf, audio/ogg)

*buildFilePart:*
4. Creates FilePartInput with correct fields
5. URL is a valid data URL

*buildMediaParts:*
6. Without caption → returns [FilePartInput] only
7. With caption → returns [TextPartInput, FilePartInput]
8. Empty caption treated as no caption

*getMimeFromFileName:*
9. `.jpg` → `image/jpeg`
10. `.pdf` → `application/pdf`
11. `.py` → `text/x-python`
12. Unknown extension → `application/octet-stream`

*extractFileRef:*
13. Photo message → picks last (highest res) photo, returns file_id
14. Document message → returns file_id + file_name + mime_type
15. Voice message → returns file_id with audio/ogg mime
16. Audio message → returns file_id + mime_type
17. Video message → returns file_id with video/mp4 mime
18. Message with no media → returns null

*downloadTelegramFile:*
(Tested with mocked getFile and fetch)
19. Downloads and returns buffer + mime + filename
20. Returns null when file_path is missing
21. Returns null when file_size > 20MB

### Group B — Wiring (bot.ts)

#### B2. bot.ts — Media handlers + handleMessage generalization (4 tests)

Changes:
- **Generalize `handleMessage`** to accept optional `parts` array parameter
- Add `bot.on("message:photo", ...)` handler
- Add `bot.on("message:document", ...)` handler
- Add `bot.on("message:voice", ...)` handler
- Add `bot.on("message:audio", ...)` handler
- Add `bot.on("message:video", ...)` handler
- All media handlers share common logic:
  1. Extract file ref from message
  2. Download file
  3. Build parts (file + optional caption)
  4. Call handleMessage with parts

**New tests:**
1. `handleMessage` with explicit parts array uses them directly (not text)
2. `handleMessage` without parts builds text part from text param (backward compat)
3. `handleMessage` with both text and parts — parts wins
4. `handleMessage` with empty parts array still works

### Group C — E2E Tests

#### C3. E2E: phase-6.test.ts (4 tests)

```ts
describe("Phase 6 — Media & Files", () => {
  test("sending photo gets AI response about the image", async () => {
    // Send a photo to the bot
    // Assert bot responds (text length > 0)
  }, 120000)

  test("sending document gets AI response", async () => {
    // Send a small text file as document
    // Assert bot responds
  }, 120000)

  test("photo with caption includes caption in response context", async () => {
    // Send photo with caption "What is this?"
    // Assert bot responds
  }, 120000)

  test("regression: text message still works after media", async () => {
    // Send /new, then text message
    // Assert bot responds
  }, 120000)
})
```

## Grammy Middleware Stack (updated)

```
  1. allowlistMiddleware(config.allowedUsers)
  2. bot.command("start", ...)
  3. bot.command("new", ...)
  4. bot.command("list", ...)
  5. bot.command("rename", ...)
  6. bot.command("delete", ...)
  7. bot.command("info", ...)
  8. bot.command("history", ...)
  9. bot.command("summarize", ...)
  10. bot.command("model", ...)
  11. bot.command("agent", ...)
  12. bot.command("cancel", ...)
  13. bot.on("callback_query:data", ...)
  14. bot.on("message:photo", ...)          ← NEW
  15. bot.on("message:document", ...)       ← NEW
  16. bot.on("message:voice", ...)          ← NEW
  17. bot.on("message:audio", ...)          ← NEW
  18. bot.on("message:video", ...)          ← NEW
  19. bot.on("message:text", ...)           ← Existing (text-only)
```

**Important:** Media handlers must come BEFORE `message:text` because a photo
with a caption also matches `message:text`. Grammy processes handlers in order
and stops at the first match.

## Edge Cases

### File Download
- `getFile` returns no `file_path` → return null, reply "Could not download file"
- File > 20MB → reject with "File too large (max 20MB)"
- Network error during fetch → catch, reply with error message
- Telegram servers slow → fetch has no built-in timeout, but Grammy handles update timeout

### MIME Types
- Photos always have MIME from Telegram (`image/jpeg` usually)
- Documents may have `mime_type` field or not → fallback to extension-based detection
- Voice messages are always `audio/ogg`
- Videos are usually `video/mp4`

### Media Groups
- Grammy delivers each photo in a media group as a separate update
- Each triggers the photo handler independently → each gets its own prompt call
- This is correct behavior: each photo is processed in the context of the session

### Caption Handling
- Photo with caption → caption becomes TextPartInput, photo becomes FilePartInput
- Photo without caption → only FilePartInput (AI infers what to do)
- Document with caption → same as photo

### Data URL Size
- A 20MB file → ~27MB base64 string → sent as JSON body to OpenCode server
- This is within typical HTTP body limits
- The OpenCode server handles forwarding to AI provider

### Sticker/Animation/Video Note
- Out of scope for Phase 6 — these are special Telegram types
- Can be added later if needed

## Acceptance Criteria

- [ ] Sending photo → bot downloads and processes image, responds with AI analysis
- [ ] Sending document → bot processes file content and responds
- [ ] Sending voice message → bot receives audio file
- [ ] Sending audio → bot receives audio file
- [ ] Sending video → bot receives video file
- [ ] Caption included as text part alongside file part
- [ ] Media groups handled (each photo processed independently)
- [ ] File > 20MB rejected with friendly message
- [ ] Text-only messages still work (backward compatible)
- [ ] `bun test src/` passes (all unit tests)
- [ ] `bun test ./e2e/phase-6.test.ts` passes
- [ ] All Phase 0-5 E2E tests still pass (regression)

## Estimated Scope

- 1 new source file + 1 test file + 1 E2E test file
- ~150-200 LOC (src) + ~250-300 LOC (tests)
- Modified: bot.ts, bot.test.ts

### Test Count Estimate

| File | New Tests |
|------|-----------|
| handlers/media.test.ts | 21 |
| bot.test.ts | 4 |
| **Unit total** | **~25 new → ~247 total** |
| E2E phase-6.test.ts | 4 |
| **E2E total** | **4 new → ~24 total** |
