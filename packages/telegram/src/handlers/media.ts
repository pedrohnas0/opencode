/**
 * Media file handling: download from Telegram, convert to data URLs,
 * and build SDK-compatible part arrays.
 */

const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB — Telegram Bot API limit

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".json": "application/json",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".py": "text/x-python",
  ".rs": "text/x-rust",
  ".go": "text/x-go",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".rb": "text/x-ruby",
  ".sh": "text/x-shellscript",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
}

export function bufferToDataUrl(buffer: Buffer, mime: string): string {
  return `data:${mime};base64,${buffer.toString("base64")}`
}

export function buildFilePart(params: {
  buffer: Buffer
  mime: string
  filename: string
}): { type: "file"; mime: string; url: string; filename: string } {
  return {
    type: "file",
    mime: params.mime,
    url: bufferToDataUrl(params.buffer, params.mime),
    filename: params.filename,
  }
}

export function buildMediaParts(params: {
  buffer: Buffer
  mime: string
  filename: string
  caption?: string
}): Array<{ type: "text"; text: string } | { type: "file"; mime: string; url: string; filename: string }> {
  const filePart = buildFilePart(params)
  if (params.caption && params.caption.trim()) {
    return [{ type: "text", text: params.caption }, filePart]
  }
  return [filePart]
}

export function getMimeFromFileName(filename: string): string {
  const dot = filename.lastIndexOf(".")
  if (dot === -1) return "application/octet-stream"
  const ext = filename.slice(dot).toLowerCase()
  return MIME_MAP[ext] ?? "application/octet-stream"
}

type TelegramMessage = {
  photo?: Array<{ file_id: string; [k: string]: unknown }>
  document?: {
    file_id: string
    file_name?: string
    mime_type?: string
    [k: string]: unknown
  }
  voice?: { file_id: string; [k: string]: unknown }
  audio?: {
    file_id: string
    mime_type?: string
    file_name?: string
    [k: string]: unknown
  }
  video?: {
    file_id: string
    mime_type?: string
    [k: string]: unknown
  }
  [k: string]: unknown
}

export function extractFileRef(
  msg: TelegramMessage,
): { fileId: string; filename?: string; mime?: string } | null {
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1]!
    return { fileId: largest.file_id, mime: "image/jpeg" }
  }

  if (msg.document) {
    return {
      fileId: msg.document.file_id,
      filename: msg.document.file_name,
      mime: msg.document.mime_type,
    }
  }

  if (msg.voice) {
    return { fileId: msg.voice.file_id, mime: "audio/ogg" }
  }

  if (msg.audio) {
    return {
      fileId: msg.audio.file_id,
      filename: msg.audio.file_name,
      mime: msg.audio.mime_type ?? "audio/mpeg",
    }
  }

  if (msg.video) {
    return {
      fileId: msg.video.file_id,
      mime: msg.video.mime_type ?? "video/mp4",
    }
  }

  return null
}

export async function downloadTelegramFile(params: {
  fileId: string
  token: string
  getFile: (fileId: string) => Promise<{ file_path?: string; file_size?: number }>
  filename?: string
  mime?: string
}): Promise<{ buffer: Buffer; mime: string; filename: string } | null> {
  const file = await params.getFile(params.fileId)

  if (!file.file_path) return null
  if (file.file_size && file.file_size > MAX_FILE_SIZE) return null

  const url = `https://api.telegram.org/file/bot${params.token}/${file.file_path}`
  const res = await fetch(url)
  const buffer = Buffer.from(await res.arrayBuffer())

  const mime =
    params.mime ??
    res.headers.get("content-type") ??
    "application/octet-stream"

  const filename =
    params.filename ?? file.file_path.split("/").pop() ?? "file"

  return { buffer, mime, filename }
}
