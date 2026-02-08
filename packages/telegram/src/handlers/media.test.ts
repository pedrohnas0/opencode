import { describe, test, expect, mock } from "bun:test"
import {
  bufferToDataUrl,
  buildFilePart,
  buildMediaParts,
  getMimeFromFileName,
  extractFileRef,
  downloadTelegramFile,
} from "./media"

// --- bufferToDataUrl ---

describe("bufferToDataUrl", () => {
  test("converts buffer to correct data URL format", () => {
    const buf = Buffer.from("hello world")
    const result = bufferToDataUrl(buf, "text/plain")
    expect(result).toBe(`data:text/plain;base64,${buf.toString("base64")}`)
  })

  test("handles empty buffer", () => {
    const buf = Buffer.alloc(0)
    const result = bufferToDataUrl(buf, "application/octet-stream")
    expect(result).toBe("data:application/octet-stream;base64,")
  })

  test("handles different MIME types", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff])
    expect(bufferToDataUrl(buf, "image/jpeg")).toStartWith("data:image/jpeg;base64,")
    expect(bufferToDataUrl(buf, "application/pdf")).toStartWith("data:application/pdf;base64,")
    expect(bufferToDataUrl(buf, "audio/ogg")).toStartWith("data:audio/ogg;base64,")
  })
})

// --- buildFilePart ---

describe("buildFilePart", () => {
  test("creates FilePartInput with correct fields", () => {
    const buf = Buffer.from("test")
    const result = buildFilePart({ buffer: buf, mime: "image/png", filename: "test.png" })
    expect(result.type).toBe("file")
    expect(result.mime).toBe("image/png")
    expect(result.filename).toBe("test.png")
    expect(result.url).toContain("data:image/png;base64,")
  })

  test("URL is a valid data URL", () => {
    const buf = Buffer.from("data")
    const result = buildFilePart({ buffer: buf, mime: "text/plain", filename: "f.txt" })
    expect(result.url).toMatch(/^data:[^;]+;base64,.+$/)
  })
})

// --- buildMediaParts ---

describe("buildMediaParts", () => {
  test("without caption returns [FilePartInput] only", () => {
    const parts = buildMediaParts({
      buffer: Buffer.from("img"),
      mime: "image/jpeg",
      filename: "photo.jpg",
    })
    expect(parts).toHaveLength(1)
    expect(parts[0]!.type).toBe("file")
  })

  test("with caption returns [TextPartInput, FilePartInput]", () => {
    const parts = buildMediaParts({
      buffer: Buffer.from("img"),
      mime: "image/jpeg",
      filename: "photo.jpg",
      caption: "What is this?",
    })
    expect(parts).toHaveLength(2)
    expect(parts[0]!.type).toBe("text")
    expect((parts[0] as any).text).toBe("What is this?")
    expect(parts[1]!.type).toBe("file")
  })

  test("empty caption treated as no caption", () => {
    const parts = buildMediaParts({
      buffer: Buffer.from("img"),
      mime: "image/jpeg",
      filename: "photo.jpg",
      caption: "",
    })
    expect(parts).toHaveLength(1)
    expect(parts[0]!.type).toBe("file")
  })
})

// --- getMimeFromFileName ---

describe("getMimeFromFileName", () => {
  test(".jpg → image/jpeg", () => {
    expect(getMimeFromFileName("photo.jpg")).toBe("image/jpeg")
  })

  test(".pdf → application/pdf", () => {
    expect(getMimeFromFileName("doc.pdf")).toBe("application/pdf")
  })

  test(".py → text/x-python", () => {
    expect(getMimeFromFileName("script.py")).toBe("text/x-python")
  })

  test("unknown extension → application/octet-stream", () => {
    expect(getMimeFromFileName("data.xyz123")).toBe("application/octet-stream")
  })
})

// --- extractFileRef ---

describe("extractFileRef", () => {
  test("photo message picks last (highest res) photo", () => {
    const msg = {
      photo: [
        { file_id: "small", file_unique_id: "s", width: 100, height: 100 },
        { file_id: "medium", file_unique_id: "m", width: 320, height: 320 },
        { file_id: "large", file_unique_id: "l", width: 1280, height: 1280 },
      ],
    }
    const ref = extractFileRef(msg as any)
    expect(ref).not.toBeNull()
    expect(ref!.fileId).toBe("large")
    expect(ref!.mime).toBe("image/jpeg")
  })

  test("document message returns file_id + file_name + mime_type", () => {
    const msg = {
      document: {
        file_id: "doc123",
        file_unique_id: "d",
        file_name: "report.pdf",
        mime_type: "application/pdf",
      },
    }
    const ref = extractFileRef(msg as any)
    expect(ref).not.toBeNull()
    expect(ref!.fileId).toBe("doc123")
    expect(ref!.filename).toBe("report.pdf")
    expect(ref!.mime).toBe("application/pdf")
  })

  test("voice message returns file_id with audio/ogg mime", () => {
    const msg = {
      voice: { file_id: "voice1", file_unique_id: "v", duration: 5 },
    }
    const ref = extractFileRef(msg as any)
    expect(ref).not.toBeNull()
    expect(ref!.fileId).toBe("voice1")
    expect(ref!.mime).toBe("audio/ogg")
  })

  test("audio message returns file_id + mime_type", () => {
    const msg = {
      audio: {
        file_id: "audio1",
        file_unique_id: "a",
        duration: 120,
        mime_type: "audio/mpeg",
      },
    }
    const ref = extractFileRef(msg as any)
    expect(ref).not.toBeNull()
    expect(ref!.fileId).toBe("audio1")
    expect(ref!.mime).toBe("audio/mpeg")
  })

  test("video message returns file_id with video/mp4 mime", () => {
    const msg = {
      video: {
        file_id: "vid1",
        file_unique_id: "v",
        width: 1920,
        height: 1080,
        duration: 30,
      },
    }
    const ref = extractFileRef(msg as any)
    expect(ref).not.toBeNull()
    expect(ref!.fileId).toBe("vid1")
    expect(ref!.mime).toBe("video/mp4")
  })

  test("message with no media returns null", () => {
    const msg = { text: "hello" }
    const ref = extractFileRef(msg as any)
    expect(ref).toBeNull()
  })
})

// --- downloadTelegramFile ---

describe("downloadTelegramFile", () => {
  test("downloads and returns buffer + mime + filename", async () => {
    const mockGetFile = mock(async () => ({
      file_path: "photos/photo.jpg",
      file_size: 1024,
    }))

    const fileContent = Buffer.from("fake image data")
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => ({
      ok: true,
      headers: new Headers({ "content-type": "image/jpeg" }),
      arrayBuffer: async () => fileContent.buffer.slice(
        fileContent.byteOffset,
        fileContent.byteOffset + fileContent.byteLength,
      ),
    })) as any

    try {
      const result = await downloadTelegramFile({
        fileId: "abc123",
        token: "BOT_TOKEN",
        getFile: mockGetFile,
        filename: "photo.jpg",
        mime: "image/jpeg",
      })

      expect(result).not.toBeNull()
      expect(result!.mime).toBe("image/jpeg")
      expect(result!.filename).toBe("photo.jpg")
      expect(result!.buffer.length).toBeGreaterThan(0)
      expect(mockGetFile).toHaveBeenCalledWith("abc123")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("returns null when file_path is missing", async () => {
    const mockGetFile = mock(async () => ({
      file_path: undefined,
      file_size: 0,
    }))

    const result = await downloadTelegramFile({
      fileId: "abc123",
      token: "BOT_TOKEN",
      getFile: mockGetFile,
      filename: "photo.jpg",
      mime: "image/jpeg",
    })

    expect(result).toBeNull()
  })

  test("returns null when file_size > 20MB", async () => {
    const mockGetFile = mock(async () => ({
      file_path: "photos/big.jpg",
      file_size: 25 * 1024 * 1024, // 25MB
    }))

    const result = await downloadTelegramFile({
      fileId: "abc123",
      token: "BOT_TOKEN",
      getFile: mockGetFile,
      filename: "big.jpg",
      mime: "image/jpeg",
    })

    expect(result).toBeNull()
  })
})
