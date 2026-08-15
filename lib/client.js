/**
 * Minimal Telegram Bot API client over `fetch`: long-polling `getUpdates`,
 * `sendMessage` with HTML or plain parse modes and optional inline keyboards,
 * `editMessageText`, `answerCallbackQuery`, `sendChatAction`, `getMe`,
 * and default-slot Command Menu `setMyCommands` / `getMyCommands`.
 * The token is embedded in the request URL, so every error path redacts it.
 * @module telegram/client
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
            allowed_updates: ['message', 'callback_query'],
        };
        if (offset !== undefined)
            body.offset = offset;
        return this.call('getUpdates', body);
    }
    /**
     * Send a text message, optionally with HTML parse mode and an inline keyboard.
     * @param chatId - target chat id.
     * @param text - the message text.
     * @param parseMode - `HTML` when the text is Telegram-HTML, else plain text.
     * @param replyMarkup - inline keyboard to attach under the message.
     * @returns the delivered message object.
     */
    sendMessage(chatId, text, parseMode, replyMarkup) {
        const body = { chat_id: chatId, text };
        if (parseMode !== undefined)
            body.parse_mode = parseMode;
        if (replyMarkup !== undefined)
            body.reply_markup = replyMarkup;
        return this.call('sendMessage', body);
    }
    /**
     * Replace a message's text and optional inline keyboard. Omit `replyMarkup`
     * or pass an empty keyboard to strip buttons.
     * @param chatId - target chat id.
     * @param messageId - the message to edit.
     * @param text - the new message text.
     * @param replyMarkup - replacement inline keyboard; empty removes buttons.
     * @returns the edited message object.
     */
    editMessageText(chatId, messageId, text, replyMarkup) {
        const body = { chat_id: chatId, message_id: messageId, text };
        if (replyMarkup !== undefined)
            body.reply_markup = replyMarkup;
        return this.call('editMessageText', body);
    }
    /**
     * Acknowledge a callback query. Telegram keeps the button spinner until this
     * succeeds; `text` is shown as a brief toast when provided.
     * @param callbackQueryId - the query id from the update.
     * @param text - optional toast shown to the user who pressed the button.
     * @returns whether the acknowledgement was accepted.
     */
    answerCallbackQuery(callbackQueryId, text) {
        const body = { callback_query_id: callbackQueryId };
        if (text !== undefined)
            body.text = text;
        return this.call('answerCallbackQuery', body);
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
    /**
     * Replace the default, unlocalized Command Menu. Omits `scope` and
     * `language_code` so Telegram writes that slot only.
     * @param commands - the full list to set; each `command` has no `/`.
     * @returns whether the list was accepted.
     */
    setMyCommands(commands) {
        return this.call('setMyCommands', { commands });
    }
    /**
     * Read the default, unlocalized Command Menu slot. Omits `scope` and
     * `language_code`. An unset slot is an empty list.
     * @returns the commands stored in that slot.
     */
    getMyCommands() {
        return this.call('getMyCommands', {});
    }
}
