/**
 * Telegram-scoped `tele_ask_user` tool: same schema as `ask_user_question` but
 * routes human input through the bridge UI instead of `ctx.userQuestions`.
 *
 * @module telegram/tele-ask-user
 */
import type { Context } from '@deepseek-ai/cordis';
import type { TelegramBridge } from './bridge.js';
/** Agent-scoped system prompt: channel context for Telegram-bound sessions. */
export declare const TELEGRAM_CHANNEL_SECTION = "telegram:channel";
export declare const TELEGRAM_SESSION_HINT: string;
/** Tell the model this agent runs over Telegram and which question tool to use. */
export declare function registerTelegramSessionHint(agentCtx: Context): void;
/** Hide global `ask_user_question` and register `tele_ask_user` on one agent scope. */
export declare function wireTeleAskUserTool(agentCtx: Context, bridge: TelegramBridge): () => void;
