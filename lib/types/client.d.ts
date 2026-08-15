/**
 * Minimal Telegram Bot API client over `fetch`: long-polling `getUpdates`,
 * `sendMessage` with HTML or plain parse modes and optional inline keyboards,
 * `editMessageText`, `answerCallbackQuery`, `sendChatAction`, `getMe`,
 * and default-slot Command Menu `setMyCommands` / `getMyCommands`.
 * The token is embedded in the request URL, so every error path redacts it.
 * @module telegram/client
 */
/** Telegram user object (sender of a message). */
export interface TelegramUser {
    readonly id: number;
    readonly first_name?: string;
    readonly username?: string;
    readonly is_bot?: boolean;
}
/** Telegram chat object (private chat, group, or channel). */
export interface TelegramChat {
    readonly id: number;
    readonly type: string;
    readonly title?: string;
    readonly username?: string;
    readonly first_name?: string;
}
/** Telegram message object; only the text-relevant fields are modeled. */
export interface TelegramMessage {
    readonly message_id: number;
    readonly chat: TelegramChat;
    readonly from?: TelegramUser;
    readonly text?: string;
    readonly date: number;
}
/** Copies `text` to the clipboard when the button is pressed. */
export interface CopyTextButton {
    readonly text: string;
}
/** One button in an inline keyboard. */
export interface InlineKeyboardButton {
    readonly text: string;
    readonly callback_data?: string;
    readonly copy_text?: CopyTextButton;
}
/** Reply markup that attaches an inline keyboard under a message. */
export interface InlineKeyboardMarkup {
    readonly inline_keyboard: readonly (readonly InlineKeyboardButton[])[];
}
/** Callback from an inline-keyboard press. */
export interface TelegramCallbackQuery {
    readonly id: string;
    readonly from: TelegramUser;
    readonly message?: TelegramMessage;
    readonly data?: string;
}
/** Telegram update envelope; message and callback_query updates are modeled. */
export interface TelegramUpdate {
    readonly update_id: number;
    readonly message?: TelegramMessage;
    readonly callback_query?: TelegramCallbackQuery;
}
/** One Command Menu entry; `command` has no leading `/`. */
export interface BotCommand {
    readonly command: string;
    readonly description: string;
}
/** Runtime seam surface tests substitute with a fake. */
export interface TelegramClientLike {
    /** Fetch the bot identity; validates the token. */
    getMe(): Promise<TelegramUser>;
    /** Long-poll for updates at or after `offset`. */
    getUpdates(offset?: number): Promise<TelegramUpdate[]>;
    /** Send a message, optionally with HTML parse mode and an inline keyboard. */
    sendMessage(chatId: number, text: string, parseMode?: 'HTML', replyMarkup?: InlineKeyboardMarkup): Promise<TelegramMessage>;
    /** Edit a message's text and optional inline keyboard. */
    editMessageText(chatId: number, messageId: number, text: string, replyMarkup?: InlineKeyboardMarkup): Promise<TelegramMessage>;
    /** Acknowledge an inline-keyboard press so Telegram stops the loading state. */
    answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>;
    /** Send a chat action such as `typing`. */
    sendChatAction(chatId: number, action: string): Promise<boolean>;
    /** Replace the default, unlocalized Command Menu. */
    setMyCommands(commands: readonly BotCommand[]): Promise<boolean>;
    /** Read the default, unlocalized Command Menu slot. */
    getMyCommands(): Promise<BotCommand[]>;
}
/** Options for {@link TelegramClient}. */
export interface TelegramClientOptions {
    /** HTTP client seam; production uses the global `fetch`. */
    fetch?: typeof fetch;
    /** API base URL; production uses the public Bot API. */
    baseUrl?: string;
    /** Long-polling timeout in seconds; production default is 30. */
    pollingTimeoutSec?: number;
}
/**
 * Minimal Bot API client. All methods throw on transport failure or a
 * non-`ok` response; thrown messages never contain the token.
 */
export declare class TelegramClient implements TelegramClientLike {
    private readonly token;
    private readonly fetchImpl;
    private readonly baseUrl;
    /** Long-polling timeout in seconds; controls each getUpdates call. */
    readonly pollingTimeoutSec: number;
    /**
     * @param token - bot token from @BotFather.
     * @param options - client options.
     */
    constructor(token: string, options?: TelegramClientOptions);
    private url;
    /** POST `method` with `body`; throws on transport failure or a non-ok response. */
    private call;
    /**
     * Fetch the bot identity; fails when the token is invalid.
     * @returns the bot user object.
     */
    getMe(): Promise<TelegramUser>;
    /**
     * Long-poll for message updates. Pass the previous update id plus one to
     * acknowledge already-seen updates; `undefined` starts from the newest.
     * @param offset - the update id to start from.
     * @returns the batch of updates received within the polling timeout.
     */
    getUpdates(offset?: number): Promise<TelegramUpdate[]>;
    /**
     * Send a text message, optionally with HTML parse mode and an inline keyboard.
     * @param chatId - target chat id.
     * @param text - the message text.
     * @param parseMode - `HTML` when the text is Telegram-HTML, else plain text.
     * @param replyMarkup - inline keyboard to attach under the message.
     * @returns the delivered message object.
     */
    sendMessage(chatId: number, text: string, parseMode?: 'HTML', replyMarkup?: InlineKeyboardMarkup): Promise<TelegramMessage>;
    /**
     * Replace a message's text and optional inline keyboard. Omit `replyMarkup`
     * or pass an empty keyboard to strip buttons.
     * @param chatId - target chat id.
     * @param messageId - the message to edit.
     * @param text - the new message text.
     * @param replyMarkup - replacement inline keyboard; empty removes buttons.
     * @returns the edited message object.
     */
    editMessageText(chatId: number, messageId: number, text: string, replyMarkup?: InlineKeyboardMarkup): Promise<TelegramMessage>;
    /**
     * Acknowledge a callback query. Telegram keeps the button spinner until this
     * succeeds; `text` is shown as a brief toast when provided.
     * @param callbackQueryId - the query id from the update.
     * @param text - optional toast shown to the user who pressed the button.
     * @returns whether the acknowledgement was accepted.
     */
    answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>;
    /**
     * Send a chat action such as `typing`; Telegram shows it briefly while a
     * real message is on the way.
     * @param chatId - target chat id.
     * @param action - the action name (for example `typing`).
     * @returns whether the action was accepted.
     */
    sendChatAction(chatId: number, action: string): Promise<boolean>;
    /**
     * Replace the default, unlocalized Command Menu. Omits `scope` and
     * `language_code` so Telegram writes that slot only.
     * @param commands - the full list to set; each `command` has no `/`.
     * @returns whether the list was accepted.
     */
    setMyCommands(commands: readonly BotCommand[]): Promise<boolean>;
    /**
     * Read the default, unlocalized Command Menu slot. Omits `scope` and
     * `language_code`. An unset slot is an empty list.
     * @returns the commands stored in that slot.
     */
    getMyCommands(): Promise<BotCommand[]>;
}
