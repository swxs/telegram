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
    '/start — choose a workspace and start a session',
    '/clear — reset the current session',
    '/skills — choose a skill',
    '/help — show this help',
].join('\n');
const CHOOSE_WORKSPACE_TEXT = 'Choose a workspace first with /start.';
const NO_WORKSPACE_TEXT = 'No workspaces are available. Create one in DeepSeek Harness first.';
const WORKSPACE_GONE_TEXT = 'That workspace is no longer available.';
const ATTACH_FAILED_TEXT = 'The session could not be attached to this workspace. It is still available.';
const PICKER_INTRO = 'Choose a workspace.';
const SKILL_PICKER_INTRO = 'Choose a skill.';
const NO_SKILL_TEXT = 'No skills are available in this workspace.';
const WORKSPACE_CALLBACK_PREFIX = 'ws:';
const SKILL_CALLBACK_PREFIX = 'sk:';
const SKILL_PAGE_SIZE = 20;
const SKILL_COLUMNS = 2;
const BUTTON_TEXT_MAX = 64;
const COMMAND_MENU = [
    { command: 'start', description: 'choose a workspace and start a session' },
    { command: 'clear', description: 'reset the current session' },
    { command: 'skills', description: 'choose a skill' },
    { command: 'help', description: 'show this help' },
];
// Floor between polls so an instant-empty transport cannot hot-loop the
// event loop; real long polling already blocks for the polling timeout.
const POLL_CADENCE_MS = 50;
/** Display title; empty titles fall back to the last path segment. */
function workspaceLabel(workspace) {
    const title = workspace.title.trim();
    if (title !== '')
        return title;
    const base = workspace.path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(part => part !== '').pop();
    return base !== undefined && base !== '' ? base : workspace.path;
}
/** Inline-keyboard label; current Workspace is marked and text is capped at 64. */
function buttonText(label, current) {
    const marked = current ? `✓ ${label}` : label;
    if (marked.length <= BUTTON_TEXT_MAX)
        return marked;
    return `${marked.slice(0, BUTTON_TEXT_MAX - 1)}…`;
}
/** Confirmation after a Workspace pick. */
function usingWorkspaceText(workspace) {
    return `Using workspace: ${workspaceLabel(workspace)}\n${workspace.path}`;
}
/** Picker body: titles live on the buttons; path is confirmed after a pick. */
function pickerText() {
    return PICKER_INTRO;
}
/** First whitespace-separated token. */
function firstToken(text) {
    return text.split(/\s+/)[0] ?? '';
}
/** First slash token with a possible `@bot` suffix stripped. */
function commandToken(text) {
    const token = firstToken(text);
    const at = token.indexOf('@');
    return at === -1 ? token : token.slice(0, at);
}
/**
 * Rewrite a `//name` invoke to `/name`, keeping the rest of the message.
 * A bare `//` token is not a Skill invoke.
 */
function rewriteSkillInvoke(text) {
    const command = commandToken(text);
    if (!command.startsWith('//') || command.length <= 2)
        return undefined;
    return `/${command.slice(2)}${text.slice(firstToken(text).length)}`;
}
/** Pack names into rows of `columns`. */
function chunkRows(items, columns) {
    const rows = [];
    for (let i = 0; i < items.length; i += columns) {
        rows.push([...items.slice(i, i + columns)]);
    }
    return rows;
}
/** Two-column Skill picker; copies `//name `; pages of 20 with Prev/Next. */
function skillPickerMarkup(names, page = 0) {
    const pageCount = Math.max(1, Math.ceil(names.length / SKILL_PAGE_SIZE));
    const safePage = Math.min(Math.max(page, 0), pageCount - 1);
    const slice = names.slice(safePage * SKILL_PAGE_SIZE, (safePage + 1) * SKILL_PAGE_SIZE);
    const rows = chunkRows(slice, SKILL_COLUMNS).map(row => row.map(name => ({
        text: buttonText(name, false),
        copy_text: { text: `//${name} ` },
    })));
    if (names.length > SKILL_PAGE_SIZE) {
        const pager = [];
        if (safePage > 0)
            pager.push({ text: '‹ Prev', callback_data: `${SKILL_CALLBACK_PREFIX}${safePage - 1}` });
        if (safePage < pageCount - 1)
            pager.push({ text: 'Next ›', callback_data: `${SKILL_CALLBACK_PREFIX}${safePage + 1}` });
        if (pager.length > 0)
            rows.push(pager);
    }
    return { inline_keyboard: rows };
}
/** One button per row; callback data is `ws:` plus the Workspace id. */
function pickerMarkup(workspaces, currentId) {
    return {
        inline_keyboard: workspaces.map(workspace => [{
                text: buttonText(workspaceLabel(workspace), currentId === String(workspace.id)),
                callback_data: `${WORKSPACE_CALLBACK_PREFIX}${String(workspace.id)}`,
            }]),
    };
}
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
    preset;
    initAdminUserIds;
    sleep;
    chats = new Map();
    /** Parked sessions keyed by `chatId:workspaceId`; switching away does not dispose them. */
    parked = new Map();
    bindings = new Map();
    offset;
    stopped = false;
    errorCount = 0;
    disposeEvents;
    /**
     * @param ctx - Cordis context providing `agents` and `agentPresets`
     * (declared by the plugin's `inject`) and the session/event stream.
     * `workspaceRegistry` is optional; without it `/start` cannot list Workspaces.
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
        const agents = [...this.chats.values(), ...this.parked.values()].map(entry => entry.handle);
        this.chats.clear();
        this.parked.clear();
        this.bindings.clear();
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
        if (update.callback_query !== undefined) {
            await this.handleCallbackQuery(update.callback_query);
            return;
        }
        const message = update.message;
        if (message === undefined)
            return;
        if (message.text === undefined)
            return;
        if (!this.authorizedFrom(message.from)) {
            await this.safeSend(message.chat.id, 'Access denied.');
            return;
        }
        if (message.text.startsWith('/')) {
            await this.handleCommand(message.chat.id, message.text, message.from?.id);
            return;
        }
        const chat = this.chats.get(String(message.chat.id));
        if (chat === undefined) {
            await this.safeSend(message.chat.id, CHOOSE_WORKSPACE_TEXT);
            return;
        }
        chat.handle.agent.followup(createUserMessage({
            content: [{ type: 'text', text: message.text }],
            source: { kind: 'user' },
        }));
    }
    authorizedFrom(from) {
        if (this.allowAllUsers)
            return true;
        return from !== undefined && this.allowedUserIds.includes(from.id);
    }
    async handleCallbackQuery(query) {
        if (!this.authorizedFrom(query.from)) {
            await this.safeAnswer(query.id, 'Access denied.');
            return;
        }
        await this.safeAnswer(query.id);
        const message = query.message;
        if (message === undefined)
            return;
        const data = query.data;
        if (data !== undefined && data.startsWith(SKILL_CALLBACK_PREFIX)) {
            const page = Number(data.slice(SKILL_CALLBACK_PREFIX.length));
            if (!Number.isInteger(page) || page < 0)
                return;
            await this.sendSkillPicker(message.chat.id, { page, edit: message });
            return;
        }
        await this.stripButtons(message);
        if (data === undefined || !data.startsWith(WORKSPACE_CALLBACK_PREFIX))
            return;
        const workspaceId = data.slice(WORKSPACE_CALLBACK_PREFIX.length);
        const chatId = message.chat.id;
        const workspace = this.lookupWorkspace(workspaceId);
        if (workspace === undefined) {
            await this.safeSend(chatId, WORKSPACE_GONE_TEXT);
            await this.sendWorkspacePicker(chatId);
            return;
        }
        await this.bindWorkspace(chatId, workspace);
    }
    async handleCommand(chatId, text, fromId) {
        const invoked = rewriteSkillInvoke(text);
        if (invoked !== undefined) {
            const chat = this.chats.get(String(chatId));
            if (chat === undefined) {
                await this.safeSend(chatId, CHOOSE_WORKSPACE_TEXT);
                return;
            }
            chat.handle.agent.followup(createUserMessage({
                content: [{ type: 'text', text: invoked }],
                source: { kind: 'user' },
            }));
            return;
        }
        const command = commandToken(text);
        if (command === '//') {
            const chat = this.chats.get(String(chatId));
            if (chat === undefined) {
                await this.safeSend(chatId, CHOOSE_WORKSPACE_TEXT);
                return;
            }
            chat.handle.agent.followup(createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'user' },
            }));
            return;
        }
        switch (command) {
            case '/start':
                await this.sendWorkspacePicker(chatId);
                break;
            case '/skills':
                await this.sendSkillPicker(chatId);
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
            case '/clear': {
                const binding = this.bindings.get(String(chatId));
                if (binding === undefined) {
                    await this.safeSend(chatId, CHOOSE_WORKSPACE_TEXT);
                    break;
                }
                const workspace = this.lookupWorkspace(binding.workspaceId);
                if (workspace === undefined) {
                    this.bindings.delete(String(chatId));
                    const previous = this.chats.get(String(chatId));
                    this.chats.delete(String(chatId));
                    if (previous !== undefined)
                        await previous.handle.dispose();
                    await this.safeSend(chatId, WORKSPACE_GONE_TEXT);
                    await this.sendWorkspacePicker(chatId);
                    break;
                }
                await this.rotateChat(chatId, workspace);
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
    registry() {
        return this.ctx.get('workspaceRegistry');
    }
    listWorkspaces() {
        const registry = this.registry();
        if (registry === undefined)
            return undefined;
        try {
            return registry.list();
        }
        catch (error) {
            this.ctx.logger.warn('[telegram] workspace list failed: %s', messageOf(error));
            return undefined;
        }
    }
    lookupWorkspace(id) {
        const registry = this.registry();
        if (registry === undefined)
            return undefined;
        try {
            return registry.get(id);
        }
        catch (error) {
            this.ctx.logger.warn('[telegram] workspace get failed: %s', messageOf(error));
            return undefined;
        }
    }
    async sendWorkspacePicker(chatId) {
        const workspaces = this.listWorkspaces();
        if (workspaces === undefined || workspaces.length === 0) {
            await this.safeSend(chatId, NO_WORKSPACE_TEXT);
            return;
        }
        const currentId = this.bindings.get(String(chatId))?.workspaceId;
        const text = pickerText();
        const markup = pickerMarkup(workspaces, currentId);
        try {
            await this.client.sendMessage(chatId, text, undefined, markup);
        }
        catch (error) {
            this.ctx.logger.error('[telegram] delivery failed: %s', messageOf(error));
        }
    }
    async sendSkillPicker(chatId, options = {}) {
        const binding = this.bindings.get(String(chatId));
        const chat = this.chats.get(String(chatId));
        if (binding === undefined || chat === undefined) {
            await this.safeSend(chatId, CHOOSE_WORKSPACE_TEXT);
            return;
        }
        const names = await this.listSkillNames(binding.path, chat.handle.agent);
        if (names === undefined || names.length === 0) {
            await this.safeSend(chatId, NO_SKILL_TEXT);
            return;
        }
        const markup = skillPickerMarkup(names, options.page ?? 0);
        const edit = options.edit;
        try {
            if (edit !== undefined) {
                await this.client.editMessageText(chatId, edit.message_id, SKILL_PICKER_INTRO, markup);
                return;
            }
            await this.client.sendMessage(chatId, SKILL_PICKER_INTRO, undefined, markup);
        }
        catch (error) {
            if (edit !== undefined) {
                this.ctx.logger.warn('[telegram] editMessageText failed: %s', messageOf(error));
                return;
            }
            this.ctx.logger.error('[telegram] delivery failed: %s', messageOf(error));
        }
    }
    /**
     * List user-invocable Skill names for this Workspace. Web mounts
     * `skill-filesystem` on the agent preset layer, so discovery needs the
     * live agent as `scope`; an unscoped host `list({ cwd })` sees none.
     */
    async listSkillNames(cwd, agent) {
        const skills = (agent.ctx.get('skills') ?? this.ctx.get('skills'));
        if (skills === undefined)
            return undefined;
        try {
            const listed = await skills.list({ cwd, scope: agent });
            return listed
                .filter(skill => skill.invocation?.userInvocable !== false)
                .map(skill => skill.name);
        }
        catch (error) {
            this.ctx.logger.warn('[telegram] skill list failed: %s', messageOf(error));
            return undefined;
        }
    }
    /**
     * Bind this chat to `workspace`. Selecting the same Workspace keeps the
     * current session. Selecting one this chat already used restores that
     * parked session. A first pick for that Workspace opens a new session,
     * attaches it, and welcomes the user. The previous session stays live
     * under its Workspace; only `/clear` and process stop dispose it.
     */
    async bindWorkspace(chatId, workspace) {
        const key = String(chatId);
        const workspaceId = String(workspace.id);
        const existing = this.chats.get(key);
        if (existing !== undefined && existing.workspaceId === workspaceId) {
            this.rememberBinding(chatId, workspace);
            await this.safeSend(chatId, usingWorkspaceText(workspace));
            return;
        }
        const restored = this.parked.get(this.parkKey(chatId, workspaceId));
        if (restored !== undefined) {
            this.parkCurrent(chatId);
            this.parked.delete(this.parkKey(chatId, workspaceId));
            this.chats.set(key, restored);
            this.rememberBinding(chatId, workspace);
            await this.safeSend(chatId, usingWorkspaceText(workspace));
            return;
        }
        this.parkCurrent(chatId);
        const opened = await this.openChat(chatId, workspace);
        this.rememberBinding(chatId, workspace);
        this.chats.set(key, opened.session);
        await this.safeSend(chatId, usingWorkspaceText(workspace));
        if (!opened.attached)
            await this.safeSend(chatId, ATTACH_FAILED_TEXT);
        await this.safeSend(chatId, WELCOME_TEXT);
    }
    rememberBinding(chatId, workspace) {
        this.bindings.set(String(chatId), {
            workspaceId: String(workspace.id),
            path: workspace.path,
            title: workspaceLabel(workspace),
        });
    }
    parkKey(chatId, workspaceId) {
        return `${chatId}:${workspaceId}`;
    }
    /** Park the chat's current session so a later pick can restore it. */
    parkCurrent(chatId) {
        const current = this.chats.get(String(chatId));
        if (current === undefined)
            return;
        this.parked.set(this.parkKey(chatId, current.workspaceId), current);
    }
    /** Replace the chat's session, keeping the bound Workspace. */
    async rotateChat(chatId, workspace) {
        const key = String(chatId);
        const previous = this.chats.get(key);
        const opened = await this.openChat(chatId, workspace);
        this.chats.set(key, opened.session);
        if (previous !== undefined)
            await previous.handle.dispose();
        if (!opened.attached)
            await this.safeSend(chatId, ATTACH_FAILED_TEXT);
    }
    async openChat(chatId, workspace) {
        const sessionId = SessionId(`telegram:${chatId}:${Date.now()}`);
        const composition = await this.composeAgent();
        const handle = await this.ctx.agents.create({
            sessionId,
            meta: { cwd: workspace.path, ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }) },
            agentOptions: { provider: this.provider, model: this.model },
            setup: composition.setup,
        });
        const attached = await this.attachWorkspace(String(sessionId), workspace);
        return {
            session: {
                chatId,
                handle,
                sessionId: String(sessionId),
                workspaceId: String(workspace.id),
            },
            attached,
        };
    }
    /**
     * Attach the session to the chosen Workspace so the chat shows under that
     * group in the harness GUI instead of [未分组]. Failures are reported to
     * the caller; the session remains usable.
     */
    async attachWorkspace(sessionId, workspace) {
        try {
            await workspace.attachSession(sessionId);
            return true;
        }
        catch (error) {
            this.ctx.logger.warn('[telegram] workspace attach failed for %s: %s', sessionId, messageOf(error));
            return false;
        }
    }
    async stripButtons(message) {
        try {
            await this.client.editMessageText(message.chat.id, message.message_id, message.text ?? PICKER_INTRO, { inline_keyboard: [] });
        }
        catch (error) {
            this.ctx.logger.warn('[telegram] editMessageText failed: %s', messageOf(error));
        }
    }
    async safeAnswer(callbackQueryId, text) {
        try {
            await this.client.answerCallbackQuery(callbackQueryId, text);
        }
        catch (error) {
            this.ctx.logger.warn('[telegram] answerCallbackQuery failed: %s', messageOf(error));
        }
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
        for (const entry of this.parked.values()) {
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
