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
import Schema from '@deepseek-ai/schemastery';
import { TelegramBridge } from './bridge.js';
export * from './bridge.js';
export * from './client.js';
export * from './format.js';
export const name = 'telegram';
// Only the agent factory is required; the surrounding composition supplies
// the LLM adapter, sessions, and tools.
export const inject = ['agents'];
export const Config = Schema.object({
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
});
/**
 * Start the Telegram bridge. Missing tokens fail loudly at load; polling and
 * session delivery run for as long as the plugin's fiber lives.
 * @param ctx - Cordis context; `agents` is injected by the plugin declaration.
 * @param config - deployment config.
 */
export function apply(ctx, config) {
    const token = config.token === '' ? process.env.DSH_TELEGRAM_TOKEN : config.token;
    if (token === undefined || token === '') {
        throw new Error('telegram: missing bot token (set config.token or DSH_TELEGRAM_TOKEN)');
    }
    const bridge = new TelegramBridge(ctx, { ...config, token });
    ctx.effect(() => {
        bridge.start();
        return () => { void bridge.stop(); };
    }, 'telegram.serve');
}
