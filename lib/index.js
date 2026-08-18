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
import { createProxiedFetch, formatProxyForLog, resolveTelegramProxy } from './proxy.js';
export * from './bridge.js';
export * from './client.js';
export * from './format.js';
export const name = 'telegram';
// `agents` creates sessions; `agentPresets` mounts the tool catalog. Missing
// presets fail at load (zero-tool agents look alive but cannot work).
// `workspaceRegistry` is optional; without it `/start` cannot list Workspaces.
// `skills` is optional; without it `/skills` has nothing to list.
export const inject = ['agents', 'agentPresets'];
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
    initAdminUserIds: Schema.array(Schema.number()).default([]),
    // Empty falls back to HTTPS_PROXY/HTTP_PROXY; only Bot API requests are proxied.
    proxy: Schema.string().default(''),
});
/**
 * Start the Telegram bridge. Missing tokens fail loudly at load; polling and
 * session delivery run for as long as the plugin's fiber lives.
 * @param ctx - Cordis context; `agents` and `agentPresets` are injected by
 * the plugin declaration.
 * @param config - deployment config.
 */
export function apply(ctx, config) {
    const token = config.token === '' ? process.env.DSH_TELEGRAM_TOKEN : config.token;
    if (token === undefined || token === '') {
        throw new Error('telegram: missing bot token (set config.token or DSH_TELEGRAM_TOKEN)');
    }
    if (ctx.get('agentPresets') === undefined) {
        throw new Error('telegram: missing agentPresets (the composition must provide the agent preset service)');
    }
    let fetchImpl;
    let closeProxy;
    // Tests inject `client`; skip proxy so HTTP_PROXY in the runner cannot
    // construct an unused agent or log a misleading "using proxy" line.
    if (config.client === undefined) {
        const proxyUrl = resolveTelegramProxy(config.proxy);
        if (proxyUrl !== undefined) {
            ctx.logger.info('[telegram] using proxy %s', formatProxyForLog(proxyUrl));
            const proxied = createProxiedFetch(proxyUrl);
            fetchImpl = proxied.fetch;
            closeProxy = () => proxied.close();
        }
    }
    const bridge = new TelegramBridge(ctx, {
        ...config,
        token,
        ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    });
    ctx.effect(() => {
        bridge.start();
        return () => {
            void bridge.stop();
            if (closeProxy !== undefined)
                void closeProxy();
        };
    }, 'telegram.serve');
}
