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
import type {
  BotCommand,
  InlineKeyboardMarkup,
  TelegramCallbackQuery,
  TelegramClientLike,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
} from './client.js'
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
  /**
   * Unused at runtime. Kept so existing profiles that set `cwd` still load.
   * Session working directories come from the Workspace the chat selects.
   */
  cwd?: string
  /** Deployment agent preset id each created agent joins (default when unset). */
  preset?: string
  /** User ids allowed to invoke `/init`; empty means nobody. */
  initAdminUserIds?: number[]
  /** Client seam; tests substitute a fake. */
  client?: TelegramClientLike
  /** Delay seam; tests substitute an instant sleep. */
  sleep?: (ms: number) => Promise<void>
}

/** One Telegram chat's current agent session. */
interface ChatSession {
  readonly chatId: number
  /** Current agent handle; `/clear` rotates it. */
  handle: AgentHandle
  /** Current session id; `/clear` rotates it. */
  sessionId: string
  /** Workspace this session was created under. */
  readonly workspaceId: string
}

/** In-memory Workspace choice for one Telegram chat. Lost on process restart. */
interface ChatBinding {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
}

/** Runtime slice of `workspaceRegistry` used by the picker and attach path. */
interface WorkspaceLike {
  readonly id: string
  readonly path: string
  readonly title: string
  attachSession(id: string): Promise<void>
}

interface WorkspaceRegistryLike {
  list(): WorkspaceLike[]
  get(id: string): WorkspaceLike | undefined
}

const WELCOME_TEXT = 'Hello! I am the DeepSeek Harness agent. Send me a message or /help for commands.'
const HELP_TEXT = [
  '/start — choose a workspace and start a session',
  '/clear — reset the current session',
  '/help — show this help',
].join('\n')
const CHOOSE_WORKSPACE_TEXT = 'Choose a workspace first with /start.'
const NO_WORKSPACE_TEXT = 'No workspaces are available. Create one in DeepSeek Harness first.'
const WORKSPACE_GONE_TEXT = 'That workspace is no longer available.'
const ATTACH_FAILED_TEXT = 'The session could not be attached to this workspace. It is still available.'
const PICKER_INTRO = 'Choose a workspace.'
const WORKSPACE_CALLBACK_PREFIX = 'ws:'
const BUTTON_TEXT_MAX = 64

const COMMAND_MENU: readonly BotCommand[] = [
  { command: 'start', description: 'choose a workspace and start a session' },
  { command: 'clear', description: 'reset the current session' },
  { command: 'help', description: 'show this help' },
]

// Floor between polls so an instant-empty transport cannot hot-loop the
// event loop; real long polling already blocks for the polling timeout.
const POLL_CADENCE_MS = 50

/** Display title; empty titles fall back to the last path segment. */
function workspaceLabel(workspace: { title: string, path: string }): string {
  const title = workspace.title.trim()
  if (title !== '') return title
  const base = workspace.path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(part => part !== '').pop()
  return base !== undefined && base !== '' ? base : workspace.path
}

/** Inline-keyboard label; current Workspace is marked and text is capped at 64. */
function buttonText(label: string, current: boolean): string {
  const marked = current ? `✓ ${label}` : label
  if (marked.length <= BUTTON_TEXT_MAX) return marked
  return `${marked.slice(0, BUTTON_TEXT_MAX - 1)}…`
}

/** Confirmation after a Workspace pick. */
function usingWorkspaceText(workspace: { title: string, path: string }): string {
  return `Using workspace: ${workspaceLabel(workspace)}\n${workspace.path}`
}

/** Picker body: titles live on the buttons; path is confirmed after a pick. */
function pickerText(): string {
  return PICKER_INTRO
}

/** One button per row; callback data is `ws:` plus the Workspace id. */
function pickerMarkup(workspaces: readonly WorkspaceLike[], currentId?: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: workspaces.map(workspace => [{
      text: buttonText(workspaceLabel(workspace), currentId === String(workspace.id)),
      callback_data: `${WORKSPACE_CALLBACK_PREFIX}${String(workspace.id)}`,
    }]),
  }
}

/** Extract the concatenated text blocks of an assistant message. */
function assistantText(event: Extract<SessionEvent, { type: 'assistant/message' }>): string | undefined {
  const blocks = event.data.message.content.filter(block => block.type === 'text')
  return blocks.length === 0 ? undefined : blocks.map(block => block.text).join('')
}

/** A stable message string for logging, whatever the thrown shape. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** True when the value looks like a Telegram update envelope (has a numeric id). */
function isUpdate(value: unknown): value is TelegramUpdate {
  return value !== null && typeof value === 'object' && typeof (value as { update_id?: unknown }).update_id === 'number'
}

/** A short, safe description of a malformed response value for logging. */
function shapeOf(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value !== 'object' && typeof value !== 'string') return typeof value
  try {
    const text = JSON.stringify(value)
    return text === undefined ? typeof value : text.length > 120 ? `${text.slice(0, 120)}…` : text
  } catch {
    return typeof value
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
  private readonly ctx: Context
  private readonly client: TelegramClientLike
  private readonly allowedUserIds: number[]
  private readonly allowAllUsers: boolean
  private readonly provider: string
  private readonly model: string
  private readonly maxMessageLength: number
  private readonly preset: string | undefined
  private readonly initAdminUserIds: number[]
  private readonly sleep: (ms: number) => Promise<void>
  private readonly chats = new Map<string, ChatSession>()
  /** Parked sessions keyed by `chatId:workspaceId`; switching away does not dispose them. */
  private readonly parked = new Map<string, ChatSession>()
  private readonly bindings = new Map<string, ChatBinding>()
  private offset: number | undefined
  private stopped = false
  private errorCount = 0
  private disposeEvents: (() => void) | undefined

  /**
   * @param ctx - Cordis context providing `agents` and `agentPresets`
   * (declared by the plugin's `inject`) and the session/event stream.
   * `workspaceRegistry` is optional; without it `/start` cannot list Workspaces.
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
    this.preset = options.preset
    this.initAdminUserIds = options.initAdminUserIds ?? []
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
    const agents = [...this.chats.values(), ...this.parked.values()].map(entry => entry.handle)
    this.chats.clear()
    this.parked.clear()
    this.bindings.clear()
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
      // `stop()` may have run while the request was in flight; drop the batch
      // instead of creating sessions or sending messages after teardown.
      if (this.stopped) return
      try {
        // The client trusts the API's `ok` flag and passes `result` through
        // unchecked; a 200 with a malformed body (direct or via a proxy) can
        // yield null/undefined/non-array and must not escape the loop.
        if (!Array.isArray(updates)) {
          this.ctx.logger.warn('[telegram] malformed getUpdates response (expected array, got %s)', shapeOf(updates))
          await this.sleep(POLL_CADENCE_MS)
          continue
        }
        for (const update of updates) {
          if (this.stopped) break
          if (!isUpdate(update)) {
            this.ctx.logger.warn('[telegram] skipped malformed update in batch: %s', shapeOf(update))
            continue
          }
          this.offset = update.update_id + 1
          try {
            await this.handleUpdate(update)
          } catch (error) {
            this.ctx.logger.error('[telegram] update %d failed: %s', update.update_id, messageOf(error))
          }
        }
        if (updates.length === 0) await this.sleep(POLL_CADENCE_MS)
      } catch (error) {
        this.ctx.logger.error('[telegram] polling iteration failed: %s', messageOf(error))
        continue
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query !== undefined) {
      await this.handleCallbackQuery(update.callback_query)
      return
    }
    const message = update.message
    if (message === undefined) return
    if (message.text === undefined) return
    if (!this.authorizedFrom(message.from)) {
      await this.safeSend(message.chat.id, 'Access denied.')
      return
    }
    if (message.text.startsWith('/')) {
      await this.handleCommand(message.chat.id, message.text, message.from?.id)
      return
    }
    const chat = this.chats.get(String(message.chat.id))
    if (chat === undefined) {
      await this.safeSend(message.chat.id, CHOOSE_WORKSPACE_TEXT)
      return
    }
    chat.handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: message.text }],
      source: { kind: 'user' },
    }))
  }

  private authorizedFrom(from?: TelegramUser): boolean {
    if (this.allowAllUsers) return true
    return from !== undefined && this.allowedUserIds.includes(from.id)
  }

  private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    if (!this.authorizedFrom(query.from)) {
      await this.safeAnswer(query.id, 'Access denied.')
      return
    }
    await this.safeAnswer(query.id)
    const message = query.message
    if (message === undefined) return
    await this.stripButtons(message)
    const data = query.data
    if (data === undefined || !data.startsWith(WORKSPACE_CALLBACK_PREFIX)) return
    const workspaceId = data.slice(WORKSPACE_CALLBACK_PREFIX.length)
    const chatId = message.chat.id
    const workspace = this.lookupWorkspace(workspaceId)
    if (workspace === undefined) {
      await this.safeSend(chatId, WORKSPACE_GONE_TEXT)
      await this.sendWorkspacePicker(chatId)
      return
    }
    await this.bindWorkspace(chatId, workspace)
  }

  private async handleCommand(chatId: number, text: string, fromId?: number): Promise<void> {
    const command = text.split(/\s+/)[0] as string
    switch (command) {
      case '/start':
        await this.sendWorkspacePicker(chatId)
        break
      case '/init':
        if (fromId === undefined || !this.initAdminUserIds.includes(fromId)) {
          await this.safeSend(chatId, `Unknown command ${command}. Send /help for commands.`)
          break
        }
        try {
          await this.client.setMyCommands(COMMAND_MENU)
          await this.safeSend(chatId, 'Initialized the command menu.')
        } catch (error) {
          this.ctx.logger.error('[telegram] setMyCommands failed: %s', messageOf(error))
          await this.safeSend(chatId, 'Failed to initialize the command menu.')
        }
        break
      case '/clear': {
        const binding = this.bindings.get(String(chatId))
        if (binding === undefined) {
          await this.safeSend(chatId, CHOOSE_WORKSPACE_TEXT)
          break
        }
        const workspace = this.lookupWorkspace(binding.workspaceId)
        if (workspace === undefined) {
          this.bindings.delete(String(chatId))
          const previous = this.chats.get(String(chatId))
          this.chats.delete(String(chatId))
          if (previous !== undefined) await previous.handle.dispose()
          await this.safeSend(chatId, WORKSPACE_GONE_TEXT)
          await this.sendWorkspacePicker(chatId)
          break
        }
        await this.rotateChat(chatId, workspace)
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

  /**
   * Resolve the deployment agent preset and the setup that joins it, so the
   * bot's agents carry the full tool catalog instead of the empty global
   * layer. Mirrors dsh-host-apiproxy's composeAgent for the web surface.
   */
  private async composeAgent(): Promise<{
    agentPreset?: string
    setup?: (agentCtx: Context) => Promise<void>
  }> {
    const presets = this.ctx.get('agentPresets') as {
      resolve(id?: string): Promise<{ id: string }>
      mount(ctx: Context, id: string): Promise<void>
    } | undefined
    if (presets === undefined) {
      throw new Error('telegram: missing agentPresets (the composition must provide the agent preset service)')
    }
    const id = (await presets.resolve(this.preset)).id
    return {
      agentPreset: id,
      setup: async agentCtx => { await presets.mount(agentCtx, id) },
    }
  }

  private registry(): WorkspaceRegistryLike | undefined {
    return this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
  }

  private listWorkspaces(): WorkspaceLike[] | undefined {
    const registry = this.registry()
    if (registry === undefined) return undefined
    try {
      return registry.list()
    } catch (error) {
      this.ctx.logger.warn('[telegram] workspace list failed: %s', messageOf(error))
      return undefined
    }
  }

  private lookupWorkspace(id: string): WorkspaceLike | undefined {
    const registry = this.registry()
    if (registry === undefined) return undefined
    try {
      return registry.get(id)
    } catch (error) {
      this.ctx.logger.warn('[telegram] workspace get failed: %s', messageOf(error))
      return undefined
    }
  }

  private async sendWorkspacePicker(chatId: number): Promise<void> {
    const workspaces = this.listWorkspaces()
    if (workspaces === undefined || workspaces.length === 0) {
      await this.safeSend(chatId, NO_WORKSPACE_TEXT)
      return
    }
    const currentId = this.bindings.get(String(chatId))?.workspaceId
    const text = pickerText()
    const markup = pickerMarkup(workspaces, currentId)
    try {
      await this.client.sendMessage(chatId, text, undefined, markup)
    } catch (error) {
      this.ctx.logger.error('[telegram] delivery failed: %s', messageOf(error))
    }
  }

  /**
   * Bind this chat to `workspace`. Selecting the same Workspace keeps the
   * current session. Selecting one this chat already used restores that
   * parked session. A first pick for that Workspace opens a new session,
   * attaches it, and welcomes the user. The previous session stays live
   * under its Workspace; only `/clear` and process stop dispose it.
   */
  private async bindWorkspace(chatId: number, workspace: WorkspaceLike): Promise<void> {
    const key = String(chatId)
    const workspaceId = String(workspace.id)
    const existing = this.chats.get(key)
    if (existing !== undefined && existing.workspaceId === workspaceId) {
      this.rememberBinding(chatId, workspace)
      await this.safeSend(chatId, usingWorkspaceText(workspace))
      return
    }
    const restored = this.parked.get(this.parkKey(chatId, workspaceId))
    if (restored !== undefined) {
      this.parkCurrent(chatId)
      this.parked.delete(this.parkKey(chatId, workspaceId))
      this.chats.set(key, restored)
      this.rememberBinding(chatId, workspace)
      await this.safeSend(chatId, usingWorkspaceText(workspace))
      return
    }
    this.parkCurrent(chatId)
    const opened = await this.openChat(chatId, workspace)
    this.rememberBinding(chatId, workspace)
    this.chats.set(key, opened.session)
    await this.safeSend(chatId, usingWorkspaceText(workspace))
    if (!opened.attached) await this.safeSend(chatId, ATTACH_FAILED_TEXT)
    await this.safeSend(chatId, WELCOME_TEXT)
  }

  private rememberBinding(chatId: number, workspace: WorkspaceLike): void {
    this.bindings.set(String(chatId), {
      workspaceId: String(workspace.id),
      path: workspace.path,
      title: workspaceLabel(workspace),
    })
  }

  private parkKey(chatId: number, workspaceId: string): string {
    return `${chatId}:${workspaceId}`
  }

  /** Park the chat's current session so a later pick can restore it. */
  private parkCurrent(chatId: number): void {
    const current = this.chats.get(String(chatId))
    if (current === undefined) return
    this.parked.set(this.parkKey(chatId, current.workspaceId), current)
  }

  /** Replace the chat's session, keeping the bound Workspace. */
  private async rotateChat(chatId: number, workspace: WorkspaceLike): Promise<void> {
    const key = String(chatId)
    const previous = this.chats.get(key)
    const opened = await this.openChat(chatId, workspace)
    this.chats.set(key, opened.session)
    if (previous !== undefined) await previous.handle.dispose()
    if (!opened.attached) await this.safeSend(chatId, ATTACH_FAILED_TEXT)
  }

  private async openChat(chatId: number, workspace: WorkspaceLike): Promise<{
    session: ChatSession
    attached: boolean
  }> {
    const sessionId = SessionId(`telegram:${chatId}:${Date.now()}`)
    const composition = await this.composeAgent()
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: workspace.path, ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }) },
      agentOptions: { provider: this.provider, model: this.model },
      setup: composition.setup,
    })
    const attached = await this.attachWorkspace(String(sessionId), workspace)
    return {
      session: {
        chatId,
        handle,
        sessionId: String(sessionId),
        workspaceId: String(workspace.id),
      },
      attached,
    }
  }

  /**
   * Attach the session to the chosen Workspace so the chat shows under that
   * group in the harness GUI instead of [未分组]. Failures are reported to
   * the caller; the session remains usable.
   */
  private async attachWorkspace(sessionId: string, workspace: WorkspaceLike): Promise<boolean> {
    try {
      await workspace.attachSession(sessionId)
      return true
    } catch (error) {
      this.ctx.logger.warn('[telegram] workspace attach failed for %s: %s', sessionId, messageOf(error))
      return false
    }
  }

  private async stripButtons(message: TelegramMessage): Promise<void> {
    try {
      await this.client.editMessageText(
        message.chat.id,
        message.message_id,
        message.text ?? PICKER_INTRO,
        { inline_keyboard: [] },
      )
    } catch (error) {
      this.ctx.logger.warn('[telegram] editMessageText failed: %s', messageOf(error))
    }
  }

  private async safeAnswer(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await this.client.answerCallbackQuery(callbackQueryId, text)
    } catch (error) {
      this.ctx.logger.warn('[telegram] answerCallbackQuery failed: %s', messageOf(error))
    }
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
    for (const entry of this.parked.values()) {
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
