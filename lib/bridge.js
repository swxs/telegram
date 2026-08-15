/**
 * Telegram→harness bridge: owns the long-polling loop, per-chat agent
 * sessions, slash commands, and delivery of assistant output back to
 * Telegram. The design mirrors Hermes' telegram platform adapter (per-chat
 * sessions, allowlist, HTML formatting, 4096-char splitting, typing
 * indicator), trimmed to the harness's text-first seams.
 * @module telegram/bridge
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { TelegramClient } from './client.js';
import { markdownToHtml, splitMessage } from './format.js';
const WELCOME_TEXT = 'Hello! I am the DeepSeek Harness agent. Send me a message or /help for commands.';
const HELP_TEXT = [
    '/start — start a session',
    '/new — start a fresh session',
    '/clear — reset the current session',
    '/help — show this help',
].join('\n');
const COMMAND_MENU = [
    { command: 'start', description: 'start a session' },
    { command: 'new', description: 'start a fresh session' },
    { command: 'clear', description: 'reset the current session' },
    { command: 'help', description: 'show this help' },
];
// Floor between polls so an instant-empty transport cannot hot-loop the
// event loop; real long polling already blocks for the polling timeout.
const POLL_CADENCE_MS = 50;
/** Extract the concatenated text blocks of an assistant message. */
function assistantText(event) {
    const blocks = event.data.message.content.filter(block => block.type === 'text');
    return blocks.length === 0 ? undefined : blocks.map(block => block.text).join('');
}
/** A stable message string for logging, whatever the thrown shape. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** True when the value looks like a Telegram update envelope (has a numeric id). */
function isUpdate(value) {
    return value !== null && typeof value === 'object' && typeof value.update_id === 'number';
}
/** A short, safe description of a malformed response value for logging. */
function shapeOf(value) {
    if (value === null)
        return 'null';
    if (typeof value !== 'object' && typeof value !== 'string')
        return typeof value;
    try {
        const text = JSON.stringify(value);
        return text === undefined ? typeof value : text.length > 120 ? `${text.slice(0, 120)}…` : text;
    }
    catch {
        return typeof value;
    }
}
/**
 * Bridge between Telegram chats and harness agent sessions. One agent
 * session per chat; incoming text becomes a user message via `followup`,
 * and assistant messages are delivered back as (split, HTML-formatted)
 * Telegram messages. Lifecycle: {@link TelegramBridge.start} begins polling,
 * {@link TelegramBridge.stop} stops it and disposes session agents.
 */
export class TelegramBridge {
    ctx;
    client;
    allowedUserIds;
    allowAllUsers;
    provider;
    model;
    maxMessageLength;
    cwd;
    preset;
    initAdminUserIds;
    sleep;
    chats = new Map();
    offset;
    stopped = false;
    errorCount = 0;
    disposeEvents;
    /**
     * @param ctx - Cordis context providing `agents` and `agentPresets`
     * (declared by the plugin's `inject`) and the session/event stream.
     * `workspaceRegistry` is optional and best-effort.
     * @param options - bridge options.
     */
    constructor(ctx, options) {
        this.ctx = ctx;
        this.client = options.client ?? new TelegramClient(options.token, {
            ...(options.pollingTimeoutSec === undefined ? {} : { pollingTimeoutSec: options.pollingTimeoutSec }),
        });
        this.allowedUserIds = options.allowedUserIds ?? [];
        this.allowAllUsers = options.allowAllUsers ?? false;
        this.provider = options.provider ?? 'deepseek-official';
        this.model = options.model ?? 'deepseek-v4-flash';
        this.maxMessageLength = options.maxMessageLength ?? 4096;
        this.cwd = options.cwd ?? process.cwd();
        this.preset = options.preset;
        this.initAdminUserIds = options.initAdminUserIds ?? [];
        this.sleep = options.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
    }
    /** Register the session listener and start the polling loop. */
    start() {
        if (this.disposeEvents !== undefined)
            return;
        this.disposeEvents = this.ctx.on('session/event', (session, event) => {
            this.handleSessionEvent(session, event);
        });
        void this.pollLoop();
    }
    /** Stop polling, unregister the listener, and dispose session agents. */
    async stop() {
        this.stopped = true;
        if (this.disposeEvents !== undefined) {
            this.disposeEvents();
            this.disposeEvents = undefined;
        }
        const agents = [...this.chats.values()].map(entry => entry.handle);
        this.chats.clear();
        await Promise.allSettled(agents.map(handle => handle.dispose()));
    }
    async pollLoop() {
        while (!this.stopped) {
            let updates;
            try {
                updates = await this.client.getUpdates(this.offset);
                this.errorCount = 0;
            }
            catch (error) {
                this.errorCount += 1;
                this.ctx.logger.warn('[telegram] polling error (attempt %d): %s', this.errorCount, messageOf(error));
                await this.sleep(Math.min(1000 * this.errorCount, 10000));
                continue;
            }
            // `stop()` may have run while the request was in flight; drop the batch
            // instead of creating sessions or sending messages after teardown.
            if (this.stopped)
                return;
            try {
                // The client trusts the API's `ok` flag and passes `result` through
                // unchecked; a 200 with a malformed body (direct or via a proxy) can
                // yield null/undefined/non-array and must not escape the loop.
                if (!Array.isArray(updates)) {
                    this.ctx.logger.warn('[telegram] malformed getUpdates response (expected array, got %s)', shapeOf(updates));
                    await this.sleep(POLL_CADENCE_MS);
                    continue;
                }
                for (const update of updates) {
                    if (this.stopped)
                        break;
                    if (!isUpdate(update)) {
                        this.ctx.logger.warn('[telegram] skipped malformed update in batch: %s', shapeOf(update));
                        continue;
                    }
                    this.offset = update.update_id + 1;
                    try {
                        await this.handleUpdate(update);
                    }
                    catch (error) {
                        this.ctx.logger.error('[telegram] update %d failed: %s', update.update_id, messageOf(error));
                    }
                }
                if (updates.length === 0)
                    await this.sleep(POLL_CADENCE_MS);
            }
            catch (error) {
                this.ctx.logger.error('[telegram] polling iteration failed: %s', messageOf(error));
                continue;
            }
        }
    }
    async handleUpdate(update) {
        const message = update.message;
        if (message === undefined)
            return;
        if (message.text === undefined)
            return;
        if (!this.authorized(message)) {
            await this.safeSend(message.chat.id, 'Access denied.');
            return;
        }
        if (message.text.startsWith('/')) {
            await this.handleCommand(message.chat.id, message.text, message.from?.id);
            return;
        }
        const chat = await this.ensureChat(message.chat.id);
        chat.handle.agent.followup(createUserMessage({
            content: [{ type: 'text', text: message.text }],
            source: { kind: 'user' },
        }));
    }
    authorized(message) {
        if (this.allowAllUsers)
            return true;
        return message.from !== undefined && this.allowedUserIds.includes(message.from.id);
    }
    async handleCommand(chatId, text, fromId) {
        const command = text.split(/\s+/)[0];
        switch (command) {
            case '/start':
                await this.ensureChat(chatId);
                await this.safeSend(chatId, WELCOME_TEXT);
                break;
            case '/init':
                if (fromId === undefined || !this.initAdminUserIds.includes(fromId)) {
                    await this.safeSend(chatId, `Unknown command ${command}. Send /help for commands.`);
                    break;
                }
                try {
                    await this.client.setMyCommands(COMMAND_MENU);
                    await this.safeSend(chatId, 'Initialized the command menu.');
                }
                catch (error) {
                    this.ctx.logger.error('[telegram] setMyCommands failed: %s', messageOf(error));
                    await this.safeSend(chatId, 'Failed to initialize the command menu.');
                }
                break;
            case '/new':
            case '/clear': {
                const chat = await this.ensureChat(chatId);
                const previous = chat.handle;
                const sessionId = SessionId(`telegram:${chatId}:${Date.now()}`);
                const composition = await this.composeAgent();
                const handle = await this.ctx.agents.create({
                    sessionId,
                    meta: { cwd: this.cwd, ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }) },
                    agentOptions: { provider: this.provider, model: this.model },
                    setup: composition.setup,
                });
                void this.attachWorkspace(String(sessionId));
                chat.handle = handle;
                chat.sessionId = String(sessionId);
                await previous.dispose();
                await this.safeSend(chatId, 'Started a fresh session.');
                break;
            }
            case '/help':
                await this.safeSend(chatId, HELP_TEXT);
                break;
            default:
                await this.safeSend(chatId, `Unknown command ${command}. Send /help for commands.`);
        }
    }
    /**
     * Resolve the deployment agent preset and the setup that joins it, so the
     * bot's agents carry the full tool catalog instead of the empty global
     * layer. Mirrors dsh-host-apiproxy's composeAgent for the web surface.
     */
    async composeAgent() {
        const presets = this.ctx.get('agentPresets');
        if (presets === undefined) {
            throw new Error('telegram: missing agentPresets (the composition must provide the agent preset service)');
        }
        const id = (await presets.resolve(this.preset)).id;
        return {
            agentPreset: id,
            setup: async (agentCtx) => { await presets.mount(agentCtx, id); },
        };
    }
    /**
     * Attach the session to the workspace for the bridge's cwd, so the chat
     * shows under the right group in the harness GUI instead of [未分组].
     * Best-effort: bookkeeping must never block message delivery.
     */
    async attachWorkspace(sessionId) {
        const registry = this.ctx.get('workspaceRegistry');
        if (registry === undefined)
            return;
        try {
            const workspace = await registry.resolveByPath(this.cwd) ?? await registry.create(this.cwd);
            await workspace.attachSession(sessionId);
        }
        catch (error) {
            this.ctx.logger.warn('[telegram] workspace attach failed for %s: %s', sessionId, messageOf(error));
        }
    }
    async ensureChat(chatId) {
        const key = String(chatId);
        const existing = this.chats.get(key);
        if (existing !== undefined)
            return existing;
        const sessionId = SessionId(`telegram:${key}`);
        const composition = await this.composeAgent();
        const handle = await this.ctx.agents.create({
            sessionId,
            meta: { cwd: this.cwd, ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }) },
            agentOptions: { provider: this.provider, model: this.model },
            setup: composition.setup,
        });
        const entry = { chatId, handle, sessionId: String(sessionId) };
        this.chats.set(key, entry);
        void this.attachWorkspace(String(sessionId));
        return entry;
    }
    handleSessionEvent(session, event) {
        const chat = this.chatFor(session);
        if (chat === undefined)
            return;
        switch (event.type) {
            case 'turn/start':
                void this.safeAction(chat.chatId, 'typing');
                break;
            case 'assistant/message': {
                const text = assistantText(event);
                if (text !== undefined)
                    void this.deliver(chat.chatId, text);
                break;
            }
            default:
                break;
        }
    }
    chatFor(session) {
        for (const entry of this.chats.values()) {
            if (entry.sessionId === session.id)
                return entry;
        }
        return undefined;
    }
    async deliver(chatId, text) {
        for (const chunk of splitMessage(text, this.maxMessageLength)) {
            await this.safeSend(chatId, chunk, 'HTML');
        }
    }
    /** Send a message; HTML failures fall back to plain text (Telegram rejects malformed entities). */
    async safeSend(chatId, text, parseMode) {
        try {
            const body = parseMode === 'HTML' ? markdownToHtml(text) : text;
            await this.client.sendMessage(chatId, body, parseMode);
        }
        catch (error) {
            if (parseMode === 'HTML') {
                try {
                    await this.client.sendMessage(chatId, text);
                }
                catch (fallbackError) {
                    this.ctx.logger.error('[telegram] delivery failed: %s', messageOf(fallbackError));
                }
            }
            else {
                this.ctx.logger.error('[telegram] delivery failed: %s', messageOf(error));
            }
        }
    }
    async safeAction(chatId, action) {
        try {
            await this.client.sendChatAction(chatId, action);
        }
        catch (error) {
            this.ctx.logger.warn('[telegram] chat action %s failed: %s', action, messageOf(error));
        }
    }
}
