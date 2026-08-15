/**
 * Telegram bridge plugin: relays Telegram chats to harness agent sessions
 * through the Bot API's long polling. Copied from Hermes' telegram platform
 * adapter design — per-chat sessions, user allowlist, HTML formatting,
 * 4096-char splitting, and a typing indicator — trimmed to the harness's
 * text-first seams. The surrounding `cordis.yml` supplies the LLM adapter,
 * agent spine, sessions, and tools.
 *
 * @module telegram
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { TelegramBridge } from './bridge.js'
import type { TelegramBridgeOptions } from './bridge.js'

export * from './bridge.js'
export * from './client.js'
export * from './format.js'

export const name = 'telegram'
// `agents` creates sessions; `agentPresets` mounts the tool catalog. Missing
// presets fail at load (zero-tool agents look alive but cannot work).
// `workspaceRegistry` is optional and resolved at runtime.
export const inject = ['agents', 'agentPresets']

/** Telegram bridge deployment config. */
export interface TelegramConfig extends Omit<TelegramBridgeOptions, 'token'> {
  /** Bot token; omitted values fall back to the `DSH_TELEGRAM_TOKEN` env var. */
  token?: string
}

export const Config: Schema<TelegramConfig> = Schema.object({
  // The schema default keeps the field present; an empty value falls back to
  // the DSH_TELEGRAM_TOKEN environment variable in apply.
  token: Schema.string().default(''),
  allowedUserIds: Schema.array(Schema.number()).default([]),
  allowAllUsers: Schema.boolean().default(false),
  provider: Schema.string().default('deepseek-official'),
  model: Schema.string().default('deepseek-v4-flash'),
  maxMessageLength: Schema.number().default(4096),
  pollingTimeoutSec: Schema.number().default(30),
  cwd: Schema.string(),
  preset: Schema.string(),
  initAdminUserIds: Schema.array(Schema.number()).default([]),
})

/**
 * Start the Telegram bridge. Missing tokens fail loudly at load; polling and
 * session delivery run for as long as the plugin's fiber lives.
 * @param ctx - Cordis context; `agents` and `agentPresets` are injected by
 * the plugin declaration.
 * @param config - deployment config.
 */
export function apply(ctx: Context, config: TelegramConfig): void {
  const token = config.token === '' ? process.env.DSH_TELEGRAM_TOKEN : config.token
  if (token === undefined || token === '') {
    throw new Error('telegram: missing bot token (set config.token or DSH_TELEGRAM_TOKEN)')
  }
  if (ctx.get('agentPresets') === undefined) {
    throw new Error('telegram: missing agentPresets (the composition must provide the agent preset service)')
  }
  const bridge = new TelegramBridge(ctx, { ...config, token })
  ctx.effect(() => {
    bridge.start()
    return () => { void bridge.stop() }
  }, 'telegram.serve')
}
