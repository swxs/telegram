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
    /** Agent working directory. */
    cwd?: string;
    /** Deployment agent preset id each created agent joins (default when unset). */
    preset?: string;
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
    private readonly cwd;
    private readonly preset;
    private readonly sleep;
    private readonly chats;
    private offset;
    private stopped;
    private errorCount;
    private disposeEvents;
    /**
     * @param ctx - Cordis context providing `agents` and `agentPresets`
     * (declared by the plugin's `inject`) and the session/event stream.
     * `workspaceRegistry` is optional and best-effort.
     * @param options - bridge options.
     */
    constructor(ctx: Context, options: TelegramBridgeOptions);
    /** Register the session listener and start the polling loop. */
    start(): void;
    /** Stop polling, unregister the listener, and dispose session agents. */
    stop(): Promise<void>;
    private pollLoop;
    private handleUpdate;
    private authorized;
    private handleCommand;
    /**
     * Resolve the deployment agent preset and the setup that joins it, so the
     * bot's agents carry the full tool catalog instead of the empty global
     * layer. Mirrors dsh-host-apiproxy's composeAgent for the web surface.
     */
    private composeAgent;
    /**
     * Attach the session to the workspace for the bridge's cwd, so the chat
     * shows under the right group in the harness GUI instead of [未分组].
     * Best-effort: bookkeeping must never block message delivery.
     */
    private attachWorkspace;
    private ensureChat;
    private handleSessionEvent;
    private chatFor;
    private deliver;
    /** Send a message; HTML failures fall back to plain text (Telegram rejects malformed entities). */
    private safeSend;
    private safeAction;
}
