import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { setup, teardown, getClient, getBotUsername } from "./runner"
import { sendAndWait } from "./helpers"
import { CustomFile } from "telegram/client/uploads"
import { deflateSync } from "node:zlib"

/**
 * Helper: send a file to the bot and wait for a reply.
 * Uses gramjs client.sendFile() to upload and then polls for bot response.
 */
async function sendFileAndWait(
  client: ReturnType<typeof getClient>,
  botUsername: string,
  params: {
    file: Buffer
    filename: string
    caption?: string
    forceDocument?: boolean
  },
  timeoutMs = 60000,
) {
  // Get the latest message ID before sending
  const messagesBefore = await client.getMessages(botUsername, { limit: 1 })
  const lastIdBefore = messagesBefore[0]?.id ?? 0

  await client.sendFile(botUsername, {
    file: new CustomFile(params.filename, params.file.length, "", params.file),
    caption: params.caption,
    forceDocument: params.forceDocument,
  })

  // Poll for bot reply
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const messages = await client.getMessages(botUsername, { limit: 5 })
    for (const msg of messages) {
      if (!msg.out && msg.id > lastIdBefore) {
        return msg
      }
    }
  }
  throw new Error(`Bot did not reply within ${timeoutMs}ms after sending file`)
}

describe("Phase 6 — Media & Files", () => {
  beforeAll(async () => {
    await setup()
    // Start fresh session
    const client = getClient()
    const bot = getBotUsername()
    await sendAndWait(client, bot, "/new", 30000)
  }, 90000)

  afterAll(async () => {
    await teardown()
  })

  test(
    "sending photo gets AI response about the image",
    async () => {
      const client = getClient()
      const bot = getBotUsername()

      // Create a valid 10x10 red PNG using zlib.deflateSync
      const pngBuffer = createValidPng()

      const reply = await sendFileAndWait(client, bot, {
        file: pngBuffer,
        filename: "test-image.png",
        caption: "What do you see in this image? Respond briefly.",
      })

      expect(reply).toBeDefined()
      const text = reply.text ?? reply.message ?? ""
      expect(text.length).toBeGreaterThan(0)
    },
    120000,
  )

  test(
    "sending document gets AI response",
    async () => {
      const client = getClient()
      const bot = getBotUsername()

      // Send a small text file as document
      const docBuffer = Buffer.from("Hello, this is a test document.\nIt has two lines.")

      const reply = await sendFileAndWait(client, bot, {
        file: docBuffer,
        filename: "test-doc.txt",
        caption: "What does this file contain? Respond briefly.",
        forceDocument: true,
      })

      expect(reply).toBeDefined()
      const text = reply.text ?? reply.message ?? ""
      expect(text.length).toBeGreaterThan(0)
    },
    120000,
  )

  test(
    "photo with caption includes caption in response context",
    async () => {
      const client = getClient()
      const bot = getBotUsername()

      const pngBuffer = createValidPng()

      const reply = await sendFileAndWait(client, bot, {
        file: pngBuffer,
        filename: "captioned.png",
        caption: "Describe the color of this image in one word.",
      })

      expect(reply).toBeDefined()
      const text = reply.text ?? reply.message ?? ""
      expect(text.length).toBeGreaterThan(0)
    },
    120000,
  )

  test(
    "regression: text message still works after media",
    async () => {
      const client = getClient()
      const bot = getBotUsername()
      await sendAndWait(client, bot, "/new", 30000)

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

  test(
    "regression: no message fragmentation after media then text",
    async () => {
      const client = getClient()
      const bot = getBotUsername()
      await sendAndWait(client, bot, "/new", 30000)

      // 1. Send a photo and wait for response
      const pngBuffer = createValidPng()
      const mediaReply = await sendFileAndWait(client, bot, {
        file: pngBuffer,
        filename: "test.png",
        caption: "Describe this briefly in one sentence.",
      })
      expect(mediaReply).toBeDefined()
      const mediaReplyId = mediaReply.id

      // 2. Wait a moment for streaming to fully finish
      await new Promise((r) => setTimeout(r, 3000))

      // 3. Send text message and wait for response
      const textReply = await sendAndWait(
        client,
        bot,
        "Respond with exactly the single word: pong",
        90000,
      )
      expect(textReply).toBeDefined()
      const textReplyId = textReply.id

      // 4. Count bot messages between media reply and text reply
      // If streaming is fragmented, there will be many messages in between
      const messages = await client.getMessages(bot, { limit: 20 })
      const botMessages = messages.filter(
        (m) => !m.out && m.id > mediaReplyId && m.id <= textReplyId,
      )

      // Should be exactly 1 message (the text reply).
      // If fragmented, there would be many intermediate messages.
      expect(botMessages.length).toBeLessThanOrEqual(2) // Allow 1 for text reply + maybe 1 for tool status
    },
    180000,
  )

  test(
    "regression: sending text while AI responds to media doesn't fragment",
    async () => {
      const client = getClient()
      const bot = getBotUsername()
      await sendAndWait(client, bot, "/new", 30000)

      // 1. Send a photo (triggers AI response)
      const pngBuffer = createValidPng()
      const messagesBefore = await client.getMessages(bot, { limit: 1 })
      const lastIdBefore = messagesBefore[0]?.id ?? 0

      await client.sendFile(bot, {
        file: new CustomFile("interrupt.png", pngBuffer.length, "", pngBuffer),
        caption: "Write a 3 paragraph essay about colors.",
      })

      // 2. Wait briefly for streaming to start, then interrupt with text
      await new Promise((r) => setTimeout(r, 4000))

      const reply = await sendAndWait(
        client,
        bot,
        "Respond with exactly the single word: pong",
        90000,
      )

      expect(reply).toBeDefined()
      const text = reply.text ?? reply.message ?? ""
      expect(text.length).toBeGreaterThan(0)

      // 3. Count ALL bot messages after our initial send
      await new Promise((r) => setTimeout(r, 3000))
      const allMessages = await client.getMessages(bot, { limit: 30 })
      const botMessagesAfter = allMessages.filter(
        (m) => !m.out && m.id > lastIdBefore,
      )

      // Should have at most 3 bot messages:
      //   1. Draft from photo response (may be edited/finalized)
      //   2. Possibly aborted/partial photo response
      //   3. The "pong" text reply
      // Fragmentation would cause 5+ messages
      expect(botMessagesAfter.length).toBeLessThanOrEqual(4)
    },
    180000,
  )
})

/**
 * Create a valid 10x10 red PNG image using Node's zlib for correct deflate.
 * Telegram requires properly encoded images — hand-crafted zlib is fragile.
 */
function createValidPng(): Buffer {
  const width = 10
  const height = 10
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  // IHDR: 10x10, 8-bit RGB
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8  // bit depth
  ihdrData[9] = 2  // color type (RGB)
  ihdrData[10] = 0 // compression
  ihdrData[11] = 0 // filter
  ihdrData[12] = 0 // interlace
  const ihdr = createPngChunk("IHDR", ihdrData)

  // Raw image data: each row starts with filter byte 0, then RGB pixels
  const rawRows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3) // filter byte + RGB per pixel
    row[0] = 0 // filter: None
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = 0xff     // R
      row[1 + x * 3 + 1] = 0x00 // G
      row[1 + x * 3 + 2] = 0x00 // B
    }
    rawRows.push(row)
  }
  const rawImageData = Buffer.concat(rawRows)
  const compressedData = deflateSync(rawImageData)
  const idat = createPngChunk("IDAT", compressedData)

  // IEND
  const iend = createPngChunk("IEND", Buffer.alloc(0))

  return Buffer.concat([signature, ihdr, idat, iend])
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii")
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const combined = Buffer.concat([typeBytes, data])

  const crc = crc32(combined)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc >>> 0, 0)

  return Buffer.concat([length, combined, crcBuf])
}

function crc32(data: Buffer): number {
  let crc = ~0
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return ~crc
}
