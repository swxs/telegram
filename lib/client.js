/**
 * Minimal Telegram Bot API client over `fetch`: long-polling `getUpdates`,
 * `sendMessage` with HTML or plain parse modes, `sendChatAction`, and `getMe`.
 * The token is embedded in the request URL, so every error path redacts it.
 * @module @dsh-external/telegram/client
 */
/** Replace the token with a placeholder in an error text. */
function redactToken(text, token) {
    return text.split(token).join('***');
}
/** Strip the bot token from any thrown value before it is logged. */
function redactedMessage(error, token) {
    const text = error instanceof Error ? error.message : String(error);
    return redactToken(text, token);
}
/**
 * Minimal Bot API client. All methods throw on transport failure or a
 * non-`ok` response; thrown messages never contain the token.
 */
export class TelegramClient {
    token;
    fetchImpl;
    baseUrl;
    /** Long-polling timeout in seconds; controls each getUpdates call. */
    pollingTimeoutSec;
    /**
     * @param token - bot token from @BotFather.
     * @param options - client options.
     */
    constructor(token, options = {}) {
        if (token === '')
            throw new Error('telegram client: token must not be empty');
        this.token = token;
        this.fetchImpl = options.fetch ?? globalThis.fetch;
        this.baseUrl = options.baseUrl ?? 'https://api.telegram.org';
        this.pollingTimeoutSec = options.pollingTimeoutSec ?? 30;
    }
    url(method) {
        return `${this.baseUrl}/bot${this.token}/${method}`;
    }
    /** POST `method` with `body`; throws on transport failure or a non-ok response. */
    async call(method, body) {
        let response;
        try {
            response = await this.fetchImpl(this.url(method), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
        }
        catch (error) {
            throw new Error(`telegram ${method} transport error: ${redactedMessage(error, this.token)}`);
        }
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.ok !== true) {
            const description = payload?.description ?? `HTTP ${response.status}`;
            throw new Error(`telegram ${method} failed: ${redactToken(description, this.token)}`);
        }
        return payload.result;
    }
    /**
     * Fetch the bot identity; fails when the token is invalid.
     * @returns the bot user object.
     */
    getMe() {
        return this.call('getMe', {});
    }
    /**
     * Long-poll for message updates. Pass the previous update id plus one to
     * acknowledge already-seen updates; `undefined` starts from the newest.
     * @param offset - the update id to start from.
     * @returns the batch of updates received within the polling timeout.
     */
    getUpdates(offset) {
        const body = {
            timeout: this.pollingTimeoutSec,
            allowed_updates: ['message'],
        };
        if (offset !== undefined)
            body.offset = offset;
        return this.call('getUpdates', body);
    }
    /**
     * Send a text message, optionally with HTML parse mode.
     * @param chatId - target chat id.
     * @param text - the message text.
     * @param parseMode - `HTML` when the text is Telegram-HTML, else plain text.
     * @returns the delivered message object.
     */
    sendMessage(chatId, text, parseMode) {
        const body = { chat_id: chatId, text };
        if (parseMode !== undefined)
            body.parse_mode = parseMode;
        return this.call('sendMessage', body);
    }
    /**
     * Send a chat action such as `typing`; Telegram shows it briefly while a
     * real message is on the way.
     * @param chatId - target chat id.
     * @param action - the action name (for example `typing`).
     * @returns whether the action was accepted.
     */
    sendChatAction(chatId, action) {
        return this.call('sendChatAction', { chat_id: chatId, action });
    }
}
