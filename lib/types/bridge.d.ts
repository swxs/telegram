/**
 * Telegram→harness bridge: owns the long-polling loop, per-chat agent
 * sessions, slash commands, and delivery of assistant output back to
 * Telegram. The design mirrors Hermes' telegram platform adapter (per-chat
 * sessions, allowlist, HTML formatting, 4096-char splitting, typing
 * indicator), trimmed to the harness's text-first seams.
 * @module telegram/bridge
 */
import type { Context } from '@deepseek-ai/cordis';
import type { TelegramClientLike } from './client.js';
/** Options for {@link TelegramBridge}. */
export interface TelegramBridgeOptions {
    /** Bot token from @BotFather. */
    token: string;
    /** User ids allowed to talk to the bot; empty means none unless `allowAllUsers`. */
    allowedUserIds?: number[];
    /** Allow any Telegram user (development only). */
    allowAllUsers?: boolean;
    /** LLM provider id passed to each created agent. */
    provider?: string;
    /** Model id passed to each created agent. */
    model?: string;
    /** Per-chunk message length limit (Telegram caps at 4096). */
    maxMessageLength?: number;
    /** Long-polling timeout in seconds. */
    pollingTimeoutSec?: number;
    /**
     * Unused at runtime. Kept so existing profiles that set `cwd` still load.
     * Session working directories come from the Workspace the chat selects.
     */
    cwd?: string;
    /** Deployment agent preset id each created agent joins (default when unset). */
    preset?: string;
    /** User ids allowed to invoke `/init`; empty means nobody. */
    initAdminUserIds?: number[];
    /**
     * HTTP/HTTPS proxy for Bot API requests. Empty falls back to
     * `HTTPS_PROXY` / `HTTP_PROXY` when the plugin loads. Ignored when `client` is set.
     */
    proxy?: string;
    /** HTTP client seam; production uses the global `fetch` or a proxied fetch. */
    fetch?: typeof fetch;
    /** Client seam; tests substitute a fake. */
    client?: TelegramClientLike;
    /** Delay seam; tests substitute an instant sleep. */
    sleep?: (ms: number) => Promise<void>;
}
/**
 * Bridge between Telegram chats and harness agent sessions. One agent
 * session per chat; incoming text becomes a user message via `followup`,
 * and assistant messages are delivered back as (split, HTML-formatted)
 * Telegram messages. Lifecycle: {@link TelegramBridge.start} begins polling,
 * {@link TelegramBridge.stop} stops it and disposes session agents.
 */
export declare class TelegramBridge {
    private readonly ctx;
    private readonly client;
    private readonly allowedUserIds;
    private readonly allowAllUsers;
    private readonly provider;
    private readonly model;
    private readonly maxMessageLength;
    private readonly preset;
    private readonly initAdminUserIds;
    private readonly sleep;
    private readonly chats;
    /** Parked sessions keyed by `chatId:workspaceId`; switching away does not dispose them. */
    private readonly parked;
    private readonly bindings;
    private offset;
    private stopped;
    private errorCount;
    private disposeEvents;
    /**
     * @param ctx - Cordis context providing `agents` and `agentPresets`
     * (declared by the plugin's `inject`) and the session/event stream.
     * `workspaceRegistry` is optional; without it `/start` cannot list Workspaces.
     * @param options - bridge options.
     */
    constructor(ctx: Context, options: TelegramBridgeOptions);
    /** Register the session listener and start the polling loop. */
    start(): void;
    /** Stop polling, unregister the listener, and dispose session agents. */
    stop(): Promise<void>;
    private pollLoop;
    private handleUpdate;
    private authorizedFrom;
    private handleCallbackQuery;
    private handleCommand;
    /**
     * Resolve the deployment agent preset and the setup that joins it, so the
     * bot's agents carry the full tool catalog instead of the empty global
     * layer. Mirrors dsh-host-apiproxy's composeAgent for the web surface.
     */
    private composeAgent;
    private registry;
    private listWorkspaces;
    private lookupWorkspace;
    private sendWorkspacePicker;
    private sendSkillPicker;
    /**
     * List user-invocable Skill names for this Workspace. Web mounts
     * `skill-filesystem` on the agent preset layer, so discovery needs the
     * live agent as `scope`; an unscoped host `list({ cwd })` sees none.
     */
    private listSkillNames;
    /**
     * Bind this chat to `workspace`. Selecting the same Workspace keeps the
     * current session. Selecting one this chat already used restores that
     * parked session. A first pick for that Workspace opens a new session,
     * attaches it, and welcomes the user. The previous session stays live
     * under its Workspace; only `/clear` and process stop dispose it.
     */
    private bindWorkspace;
    private rememberBinding;
    private parkKey;
    /** Park the chat's current session so a later pick can restore it. */
    private parkCurrent;
    /** Replace the chat's session, keeping the bound Workspace. */
    private rotateChat;
    private openChat;
    /**
     * Attach the session to the chosen Workspace so the chat shows under that
     * group in the harness GUI instead of [未分组]. Failures are reported to
     * the caller; the session remains usable.
     */
    private attachWorkspace;
    private stripButtons;
    private safeAnswer;
    private handleSessionEvent;
    private chatFor;
    private deliver;
    /** Send a message; HTML failures fall back to plain text (Telegram rejects malformed entities). */
    private safeSend;
    private safeAction;
}
