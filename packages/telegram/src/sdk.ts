/**
 * SDK client factory.
 *
 * Two modes:
 *   1. OPENCODE_URL set → connect to existing server (production/manual)
 *   2. OPENCODE_URL not set → spawn local server from monorepo source (dev)
 *
 * Returns { client, cleanup } where cleanup stops the spawned server (if any).
 */

import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk"
import { spawn as nodeSpawn } from "node:child_process"
import { resolve } from "node:path"

export type SdkHandle = {
  client: OpencodeClient
  url: string
  cleanup: () => void
}

export async function initSdk(opts: {
  opencodeUrl?: string
  projectDirectory: string
}): Promise<SdkHandle> {
  if (opts.opencodeUrl) {
    // Connect to existing server
    const client = createOpencodeClient({
      baseUrl: opts.opencodeUrl,
      directory: opts.projectDirectory,
    })
    return { client, url: opts.opencodeUrl, cleanup: () => {} }
  }

  // Spawn local server from monorepo source
  const { url, proc } = await spawnOpencodeServer(opts.projectDirectory)
  const client = createOpencodeClient({
    baseUrl: url,
    directory: opts.projectDirectory,
  })
  return {
    client,
    url,
    cleanup: () => proc.kill(),
  }
}

async function spawnOpencodeServer(projectDirectory: string): Promise<{
  url: string
  proc: ReturnType<typeof nodeSpawn>
}> {
  // CWD must be the opencode package (for module resolution)
  // The project directory is passed via the SDK client's x-opencode-directory header
  const monorepoRoot = resolve(import.meta.dir, "../../..")
  const opencodeDir = resolve(monorepoRoot, "packages/opencode")

  const proc = nodeSpawn(
    process.execPath,
    ["run", "--conditions=browser", "./src/index.ts", "serve", "--port=0"],
    {
      cwd: opencodeDir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  const url = await waitForServerUrl(proc, 30000)
  return { url, proc }
}

async function waitForServerUrl(
  proc: ReturnType<typeof nodeSpawn>,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ""
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `OpenCode server did not start within ${timeoutMs}ms. Output: ${output}`,
        ),
      )
    }, timeoutMs)

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(
        /opencode server listening on (https?:\/\/[^\s]+)/,
      )
      if (match) {
        clearTimeout(timeout)
        resolve(match[1])
      }
    })

    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })

    proc.on("exit", (code) => {
      clearTimeout(timeout)
      reject(
        new Error(
          `OpenCode server exited with code ${code}. Output: ${output}`,
        ),
      )
    })

    proc.on("error", (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}
