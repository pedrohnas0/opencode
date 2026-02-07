import { TelegramClient } from "telegram"
import { StringSession } from "telegram/sessions"

export type TestClientConfig = {
  apiId: number
  apiHash: string
  session: string
}

export async function createTestClient(
  config: TestClientConfig,
): Promise<TelegramClient> {
  const client = new TelegramClient(
    new StringSession(config.session),
    config.apiId,
    config.apiHash,
    {
      connectionRetries: 3,
      retryDelay: 1000,
    },
  )
  await client.connect()
  return client
}
