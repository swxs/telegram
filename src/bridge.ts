/**
 * Telegram→harness bridge: owns the long-polling loop, per-chat agent
 * sessions, slash commands, and delivery of assistant output back to
 * Telegram. The design mirrors Hermes' telegram platform adapter (per-chat
 * sessions, allowlist, HTML formatting, 4096-char splitting, typing
 * indicator), trimmed to the harness's text-first seams.
 * @module telegram/bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TelegramClient } from './client.js'
import type { TelegramClientLike, TelegramMessage, TelegramUpdate } from './client.js'
import { markdownToHtml, splitMessage } from './format.js'

/** Options for {@link TelegramBridge}. */
export interface TelegramBridgeOptions {
  /** Bot token from @BotFather. */
  token: string
  /** User ids allowed to talk to the bot; empty means none unless `allowAllUsers`. */
  allowedUserIds?: number[]
  /** Allow any Telegram user (development only). */
  allowAllUsers?: boolean
  /** LLM provider id passed to each created agent. */
  provider?: string
  /** Model id passed to each created agent. */
  model?: string
  /** Per-chunk message length limit (Telegram caps at 4096). */
  maxMessageLength?: number
  /** Long-polling timeout in seconds. */
  pollingTimeoutSec?: number
  /** Agent working directory. */
  cwd?: string
  /** Client seam; tests substitute a fake. */
  client?: TelegramClientLike
  /** Delay seam; tests substitute an instant sleep. */
  sleep?: (ms: number) => Promise<void>
}

/** One Telegram chat's current agent session. */
interface ChatSession {
  readonly chatId: number
  /** Current agent handle; `/new` and `/clear` rotate it. */
  handle: AgentHandle
  /** Current session id; `/new` and `/clear` rotate it. */
  sessionId: string
}

const WELCOME_TEXT = 'Hello! I am the DeepSeek Harness agent. Send me a message or /help for commands.'
const HELP_TEXT = [
  '/start — start a session',
  '/new — start a fresh session',
  '/clear — reset the current session',
  '/help — show this help',
].join('\n')

// Floor between polls so an instant-empty transport cannot hot-loop the
// event loop; real long polling already blocks for the polling timeout.
const POLL_CADENCE_MS = 50

/** Extract the concatenated text blocks of an assistant message. */
function assistantText(event: Extract<SessionEvent, { type: 'assistant/message' }>): string | undefined {
  const blocks = event.data.message.content.filter(block => block.type === 'text')
  return blocks.length === 0 ? undefined : blocks.map(block => block.text).join('')
}

/** A stable message string for logging, whatever the thrown shape. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Bridge between Telegram chats and harness agent sessions. One agent
 * session per chat; incoming text becomes a user message via `followup`,
 * and assistant messages are delivered back as (split, HTML-formatted)
 * Telegram messages. Lifecycle: {@link TelegramBridge.start} begins polling,
 * {@link TelegramBridge.stop} stops it and disposes session agents.
 */
export class TelegramBridge {
  private readonly ctx: Context
  private readonly client: TelegramClientLike
  private readonly allowedUserIds: number[]
  private readonly allowAllUsers: boolean
  private readonly provider: string
  private readonly model: string
  private readonly maxMessageLength: number
  private readonly cwd: string
  private readonly sleep: (ms: number) => Promise<void>
  private readonly chats = new Map<string, ChatSession>()
  private offset: number | undefined
  private stopped = false
  private errorCount = 0
  private disposeEvents: (() => void) | undefined

  /**
   * @param ctx - Cordis context providing `agents` (declared by the plugin's
   * `inject`) and the session/event stream.
   * @param options - bridge options.
   */
  constructor(ctx: Context, options: TelegramBridgeOptions) {
    this.ctx = ctx
    this.client = options.client ?? new TelegramClient(options.token, {
      ...(options.pollingTimeoutSec === undefined ? {} : { pollingTimeoutSec: options.pollingTimeoutSec }),
    })
    this.allowedUserIds = options.allowedUserIds ?? []
    this.allowAllUsers = options.allowAllUsers ?? false
    this.provider = options.provider ?? 'deepseek-official'
    this.model = options.model ?? 'deepseek-v4-flash'
    this.maxMessageLength = options.maxMessageLength ?? 4096
    this.cwd = options.cwd ?? process.cwd()
    this.sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /** Register the session listener and start the polling loop. */
  start(): void {
    if (this.disposeEvents !== undefined) return
    this.disposeEvents = this.ctx.on('session/event', (session, event) => {
      this.handleSessionEvent(session, event)
    })
    void this.pollLoop()
  }

  /** Stop polling, unregister the listener, and dispose session agents. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.disposeEvents !== undefined) {
      this.disposeEvents()
      this.disposeEvents = undefined
    }
    const agents = [...this.chats.values()].map(entry => entry.handle)
    this.chats.clear()
    await Promise.allSettled(agents.map(handle => handle.dispose()))
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      let updates: TelegramUpdate[]
      try {
        updates = await this.client.getUpdates(this.offset)
        this.errorCount = 0
      } catch (error) {
        this.errorCount += 1
        this.ctx.logger.warn('[telegram] polling error (attempt %d): %s', this.errorCount, messageOf(error))
        await this.sleep(Math.min(1000 * this.errorCount, 10000))
        continue
      }
      for (const update of updates) {
        this.offset = update.update_id + 1
        try {
          await this.handleUpdate(update)
        } catch (error) {
          this.ctx.logger.error('[telegram] update %d failed: %s', update.update_id, messageOf(error))
        }
      }
      if (updates.length === 0) await this.sleep(POLL_CADENCE_MS)
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message
    if (message === undefined) return
    if (message.text === undefined) return
    if (!this.authorized(message)) {
      await this.safeSend(message.chat.id, 'Access denied.')
      return
    }
    if (message.text.startsWith('/')) {
      await this.handleCommand(message.chat.id, message.text)
      return
    }
    const chat = await this.ensureChat(message.chat.id)
    chat.handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: message.text }],
      source: { kind: 'user' },
    }))
  }

  private authorized(message: TelegramMessage): boolean {
    if (this.allowAllUsers) return true
    return message.from !== undefined && this.allowedUserIds.includes(message.from.id)
  }

  private async handleCommand(chatId: number, text: string): Promise<void> {
    const command = text.split(/\s+/)[0] as string
    switch (command) {
      case '/start':
        await this.ensureChat(chatId)
        await this.safeSend(chatId, WELCOME_TEXT)
        break
      case '/new':
      case '/clear': {
        const chat = await this.ensureChat(chatId)
        const previous = chat.handle
        const sessionId = SessionId(`telegram:${chatId}:${Date.now()}`)
        const handle = await this.ctx.agents.create({
          sessionId,
          meta: { cwd: this.cwd },
          agentOptions: { provider: this.provider, model: this.model },
        })
        chat.handle = handle
        chat.sessionId = String(sessionId)
        await previous.dispose()
        await this.safeSend(chatId, 'Started a fresh session.')
        break
      }
      case '/help':
        await this.safeSend(chatId, HELP_TEXT)
        break
      default:
        await this.safeSend(chatId, `Unknown command ${command}. Send /help for commands.`)
    }
  }

  private async ensureChat(chatId: number): Promise<ChatSession> {
    const key = String(chatId)
    const existing = this.chats.get(key)
    if (existing !== undefined) return existing
    const sessionId = SessionId(`telegram:${key}`)
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: this.cwd },
      agentOptions: { provider: this.provider, model: this.model },
    })
    const entry: ChatSession = { chatId, handle, sessionId: String(sessionId) }
    this.chats.set(key, entry)
    return entry
  }

  private handleSessionEvent(session: Session, event: SessionEvent): void {
    const chat = this.chatFor(session)
    if (chat === undefined) return
    switch (event.type) {
      case 'turn/start':
        void this.safeAction(chat.chatId, 'typing')
        break
      case 'assistant/message': {
        const text = assistantText(event)
        if (text !== undefined) void this.deliver(chat.chatId, text)
        break
      }
      default:
        break
    }
  }

  private chatFor(session: Session): ChatSession | undefined {
    for (const entry of this.chats.values()) {
      if (entry.sessionId === session.id) return entry
    }
    return undefined
  }

  private async deliver(chatId: number, text: string): Promise<void> {
    for (const chunk of splitMessage(text, this.maxMessageLength)) {
      await this.safeSend(chatId, chunk, 'HTML')
    }
  }

  /** Send a message; HTML failures fall back to plain text (Telegram rejects malformed entities). */
  private async safeSend(chatId: number, text: string, parseMode?: 'HTML'): Promise<void> {
    try {
      const body = parseMode === 'HTML' ? markdownToHtml(text) : text
      await this.client.sendMessage(chatId, body, parseMode)
    } catch (error) {
      if (parseMode === 'HTML') {
        try {
          await this.client.sendMessage(chatId, text)
        } catch (fallbackError) {
          this.ctx.logger.error('[telegram] delivery failed: %s', messageOf(fallbackError))
        }
      } else {
        this.ctx.logger.error('[telegram] delivery failed: %s', messageOf(error))
      }
    }
  }

  private async safeAction(chatId: number, action: string): Promise<void> {
    try {
      await this.client.sendChatAction(chatId, action)
    } catch (error) {
      this.ctx.logger.warn('[telegram] chat action %s failed: %s', action, messageOf(error))
    }
  }
}
