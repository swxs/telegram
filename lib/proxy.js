/**
 * Telegram Bot API proxy: resolve an HTTP/HTTPS proxy URL and wrap `fetch`
 * so only this client's requests go through it. Does not mutate process env
 * or install a global dispatcher.
 * @module telegram/proxy
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
/**
 * Resolve the Bot API proxy URL. A non-empty `configProxy` wins; otherwise
 * `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy` are tried in
 * that order. Missing values mean direct `fetch`. Invalid URLs throw.
 * @param configProxy - plugin config `proxy`; empty/whitespace is unset.
 * @param env - environment map; production passes `process.env`.
 * @returns the proxy URL, or `undefined` for a direct connection.
 */
export function resolveTelegramProxy(configProxy, env = process.env) {
    const configured = configProxy?.trim() ?? '';
    if (configured !== '')
        return validatedProxyUrl(configured, 'config');
    for (const key of PROXY_ENV_KEYS) {
        const value = env[key]?.trim() ?? '';
        if (value !== '')
            return validatedProxyUrl(value, key);
    }
    return undefined;
}
/**
 * Host (and redacted userinfo) suitable for logs; never includes a password.
 * @param proxyUrl - a URL already accepted by {@link resolveTelegramProxy}.
 */
export function formatProxyForLog(proxyUrl) {
    const parsed = new URL(proxyUrl);
    const auth = parsed.username !== '' || parsed.password !== '' ? '***@' : '';
    return `${parsed.protocol}//${auth}${parsed.host}`;
}
/**
 * Wrap `fetch` so HTTPS Bot API calls CONNECT through `proxyUrl`. Close the
 * agent when the plugin fiber disposes.
 * @param proxyUrl - HTTP or HTTPS proxy URL.
 */
export function createProxiedFetch(proxyUrl) {
    const agent = new TelegramProxyAgent(new URL(proxyUrl));
    const proxied = ((input, init) => {
        return new Promise((resolve, reject) => {
            const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            const url = new URL(href);
            if (url.protocol !== 'https:') {
                reject(new Error('telegram proxy: only https targets are supported'));
                return;
            }
            const req = https.request(url, {
                method: init?.method ?? 'GET',
                headers: headersToRecord(init?.headers),
                agent,
            }, (res) => {
                const chunks = [];
                res.on('data', chunk => { chunks.push(chunk); });
                res.on('end', () => {
                    resolve(new Response(Buffer.concat(chunks), {
                        status: res.statusCode ?? 502,
                        headers: flattenHeaders(res.headers),
                    }));
                });
            });
            req.on('error', reject);
            if (init?.body !== undefined && init.body !== null)
                req.write(init.body);
            req.end();
        });
    });
    return {
        fetch: proxied,
        close: () => {
            agent.destroy();
            return Promise.resolve();
        },
    };
}
/** HTTPS agent that CONNECTs through an HTTP/HTTPS proxy, then TLS-wraps the tunnel. */
class TelegramProxyAgent extends https.Agent {
    proxy;
    constructor(proxy) {
        super({ keepAlive: true });
        this.proxy = proxy;
    }
    createConnection(options, callback) {
        const host = String(options.servername ?? options.hostname ?? options.host);
        const port = Number(options.port === undefined || options.port === '' ? 443 : options.port);
        connectViaProxy(this.proxy, host, port, (error, socket) => {
            callback?.(error, socket);
        });
        return undefined;
    }
}
/** Accept only `http:` / `https:` absolute URLs with a hostname. */
function validatedProxyUrl(raw, source) {
    let parsed;
    try {
        parsed = new URL(raw);
    }
    catch {
        throw new Error(`telegram: invalid proxy URL from ${source}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`telegram: invalid proxy URL from ${source} (need http:// or https://)`);
    }
    if (parsed.hostname === '') {
        throw new Error(`telegram: invalid proxy URL from ${source}`);
    }
    return raw;
}
/** CONNECT to `targetHost:targetPort` through `proxy`, then TLS-wrap the tunnel. */
function connectViaProxy(proxy, targetHost, targetPort, callback) {
    let settled = false;
    const done = (error, socket) => {
        if (settled)
            return;
        settled = true;
        callback(error, socket);
    };
    const proxyPort = proxy.port === '' ? (proxy.protocol === 'https:' ? 443 : 80) : Number(proxy.port);
    const authority = hostPort(targetHost, targetPort);
    const headers = { host: authority };
    if (proxy.username !== '' || proxy.password !== '') {
        const user = decodeURIComponent(proxy.username);
        const pass = decodeURIComponent(proxy.password);
        headers['proxy-authorization'] = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    }
    const requestImpl = proxy.protocol === 'https:' ? https.request : http.request;
    const req = requestImpl({
        protocol: proxy.protocol,
        hostname: proxy.hostname,
        port: proxyPort,
        method: 'CONNECT',
        path: authority,
        headers,
    });
    req.once('connect', (res, socket) => {
        if (res.statusCode !== 200) {
            socket.destroy();
            done(new Error(`telegram proxy CONNECT failed: HTTP ${res.statusCode}`));
            return;
        }
        const tlsSocket = tls.connect({ socket, host: targetHost, servername: targetHost }, () => {
            done(null, tlsSocket);
        });
        tlsSocket.once('error', done);
    });
    req.once('error', done);
    req.end();
}
/** `host:port`, with brackets around IPv6 literals. */
function hostPort(host, port) {
    return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}
/** Flatten fetch headers into a record `https.request` accepts. */
function headersToRecord(headers) {
    if (headers === undefined)
        return {};
    const record = {};
    if (headers instanceof Headers) {
        for (const [key, value] of headers.entries())
            record[key] = value;
        return record;
    }
    if (Array.isArray(headers)) {
        for (const [key, value] of headers)
            record[key] = value;
        return record;
    }
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined)
            continue;
        record[key] = (Array.isArray(value) ? value.join(', ') : value);
    }
    return record;
}
/** Flatten Node IncomingHttpHeaders into a fetch HeadersInit list. */
function flattenHeaders(headers) {
    const list = [];
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined)
            continue;
        list.push([key, Array.isArray(value) ? value.join(', ') : value]);
    }
    return list;
}
