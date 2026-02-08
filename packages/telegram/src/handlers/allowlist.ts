/**
 * Allowlist middleware — restricts bot access to specific Telegram user IDs.
 *
 * Safe default: empty list blocks everyone. The bot owner must explicitly
 * configure TELEGRAM_ALLOWED_USERS with their Telegram ID(s).
 *
 * - allowAll=true (TELEGRAM_ALLOWED_USERS="*") → allow everyone (explicit opt-in)
 * - allowedUsers=[123,456] → only those IDs
 * - allowedUsers=[] + allowAll=false → block everyone (safe default)
 */

import type { MiddlewareFn, Context } from "grammy"

export function createAllowlistMiddleware(
  allowedUsers: number[],
  allowAll = false,
): MiddlewareFn<Context> {
  if (allowAll) {
    return (_ctx, next) => next()
  }

  if (allowedUsers.length === 0) {
    return () => {} // block everyone — no users configured
  }

  const allowed = new Set(allowedUsers)

  return (ctx, next) => {
    const userId = ctx.from?.id
    if (!userId || !allowed.has(userId)) return
    return next()
  }
}
