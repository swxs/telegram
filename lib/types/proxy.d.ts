/**
 * Telegram Bot API proxy: resolve an HTTP/HTTPS proxy URL and wrap `fetch`
 * so only this client's requests go through it. Does not mutate process env
 * or install a global dispatcher.
 * @module telegram/proxy
 */
/** A `fetch` that tunnels through a proxy, plus a close hook for shutdown. */
export interface ProxiedFetch {
    readonly fetch: typeof fetch;
    close(): Promise<void>;
}
/**
 * Resolve the Bot API proxy URL. A non-empty `configProxy` wins; otherwise
 * `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy` are tried in
 * that order. Missing values mean direct `fetch`. Invalid URLs throw.
 * @param configProxy - plugin config `proxy`; empty/whitespace is unset.
 * @param env - environment map; production passes `process.env`.
 * @returns the proxy URL, or `undefined` for a direct connection.
 */
export declare function resolveTelegramProxy(configProxy: string | undefined, env?: NodeJS.Dict<string>): string | undefined;
/**
 * Host (and redacted userinfo) suitable for logs; never includes a password.
 * @param proxyUrl - a URL already accepted by {@link resolveTelegramProxy}.
 */
export declare function formatProxyForLog(proxyUrl: string): string;
/**
 * Wrap `fetch` so HTTPS Bot API calls CONNECT through `proxyUrl`. Close the
 * agent when the plugin fiber disposes.
 * @param proxyUrl - HTTP or HTTPS proxy URL.
 */
export declare function createProxiedFetch(proxyUrl: string): ProxiedFetch;
