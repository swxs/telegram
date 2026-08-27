/**
 * Telegram→harness bridge: owns the long-polling loop, per-chat agent
 * sessions, slash commands, and delivery of assistant output back to
 * Telegram. The design mirrors Hermes' telegram platform adapter (per-chat
 * sessions, allowlist, HTML formatting, 4096-char splitting, typing
 * indicator), trimmed to the harness's text-first seams.
 * @module telegram/bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TelegramClient } from './client.js'
import type {
  BotCommand,
  ForceReplyMarkup,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  ReplyMarkup,
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
  /**
   * HTTP/HTTPS proxy for Bot API requests. Empty falls back to
   * `HTTPS_PROXY` / `HTTP_PROXY` when the plugin loads. Ignored when `client` is set.
   */
  proxy?: string
  /** HTTP client seam; production uses the global `fetch` or a proxied fetch. */
  fetch?: typeof fetch
  /** Client seam; tests substitute a fake. */
  client?: TelegramClientLike
  /** Delay seam; tests substitute an instant sleep. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Register `userQuestions` provider for Telegram UI. When false, only
   * approval is wired (for compositions where the web host owns questions).
   */
  registerQuestionProvider?: boolean
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

/** Runtime slice of `ctx.skills` used by the skill picker. */
interface SkillLike {
  readonly name: string
  readonly invocation?: { readonly userInvocable?: boolean }
}

interface SkillsLike {
  list(options?: { cwd?: string, scope?: unknown }): Promise<SkillLike[]>
}

const WELCOME_TEXT = 'Hello! I am the DeepSeek Harness agent. Send me a message or /help for commands.'
const HELP_TEXT = [
  '/start — choose a workspace and start a session',
  '/clear — reset the current session',
  '/skills — choose a skill',
  '/help — show this help',
].join('\n')
const CHOOSE_WORKSPACE_TEXT = 'Choose a workspace first with /start.'
const NO_WORKSPACE_TEXT = 'No workspaces are available. Create one in DeepSeek Harness first.'
const WORKSPACE_GONE_TEXT = 'That workspace is no longer available.'
const ATTACH_FAILED_TEXT = 'The session could not be attached to this workspace. It is still available.'
const PICKER_INTRO = 'Choose a workspace.'
const SKILL_PICKER_INTRO = 'Choose a skill.'
const NO_SKILL_TEXT = 'No skills are available in this workspace.'
const WORKSPACE_CALLBACK_PREFIX = 'ws:'
const SKILL_CALLBACK_PREFIX = 'sk:'
const USER_QUESTION_CALLBACK_PREFIX = 'uq:'
const APPROVAL_CALLBACK_PREFIX = 'ap:'
const SKILL_PAGE_SIZE = 20
const SKILL_COLUMNS = 2
const BUTTON_TEXT_MAX = 64
const PENDING_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
const PENDING_INTERACTION_TEXT = 'Please complete the pending interaction above first.'
const FORCE_REPLY_PROMPT = 'Enter your answer:'
const FORCE_REPLY_PLAN_PROMPT = 'Enter feedback to continue planning:'

/** Closed approval outcomes from `@deepseek-ai/dsh-user-approval`. */
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** One selectable option in a user-questions request. */
interface AskUserQuestionOption {
  readonly label: string
  readonly description?: string
}

/** Plan-review or generic presentation intent on a question. */
interface AskUserQuestionIntent {
  readonly kind: 'plan-review'
  readonly approve: string
}

/** One question in a user-questions batch. */
interface AskUserQuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options?: readonly AskUserQuestionOption[]
  readonly multiSelect?: boolean
  readonly intent?: AskUserQuestionIntent
}

/** Human answer to one question. */
interface AskUserQuestionAnswerItem {
  readonly id: string
  readonly selected: string[]
  readonly custom?: string
}

/** Full answer payload for `userQuestions.ask()`. */
interface AskUserQuestionAnswer {
  readonly answers: AskUserQuestionAnswerItem[]
}

/** User-questions provider request. */
interface AskUserQuestionRequest {
  readonly questions: readonly AskUserQuestionItem[]
  readonly agent?: Agent
  readonly signal?: AbortSignal
}

interface UserQuestionsLike {
  registerProvider(provider: { ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> }): () => void
}

/** Approval waterfall request (subset used by the bridge). */
interface ApprovalRequestLike {
  readonly agent: Agent
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

interface QuestionPendingState {
  readonly kind: 'question'
  readonly id: string
  readonly chatId: number
  readonly sessionId: string
  readonly request: AskUserQuestionRequest
  readonly resolve: (answer: AskUserQuestionAnswer) => void
  readonly reject: (error: Error) => void
  readonly questions: readonly AskUserQuestionItem[]
  readonly answers: Map<string, { selected: string[], custom?: string }>
  currentQuestionIndex: number
  multiSelectSelected: Set<number>
  anchorMessageId?: number
  anchorPlainText?: string
  forceReplyMessageId?: number
  waitingCustom: boolean
  onAbort?: () => void
}

interface ApprovalPendingState {
  readonly kind: 'approval'
  readonly id: string
  readonly chatId: number
  readonly sessionId: string
  readonly approvalId: string
  readonly toolName: string
  readonly reason?: string
  readonly resolve: (outcome: ApprovalOutcome) => void
  readonly signal?: AbortSignal
  anchorMessageId?: number
  anchorPlainText?: string
  onAbort?: () => void
}

type PendingState = QuestionPendingState | ApprovalPendingState

interface ChatPendingBucket {
  readonly items: PendingState[]
}

/** Error shape compatible with `@deepseek-ai/dsh-user-questions`. */
class BridgeUserQuestionError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'UserQuestionError'
    this.code = code
  }
}

function isDuplicateProviderError(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && (error as { code: unknown }).code === 'DUPLICATE_PROVIDER'
}

const COMMAND_MENU: readonly BotCommand[] = [
  { command: 'start', description: 'choose a workspace and start a session' },
  { command: 'clear', description: 'reset the current session' },
  { command: 'skills', description: 'choose a skill' },
  { command: 'help', description: 'show this help' },
]

// Floor between polls so an instant-empty transport cannot hot-loop the
// event loop; real long polling already blocks for the polling timeout.
const POLL_CADENCE_MS = 50

/** A short random id for callback_data (≤64B with verb prefix). */
function generatePendingId(): string {
  let id = ''
  for (let index = 0; index < 4; index += 1) {
    id += PENDING_ID_ALPHABET[Math.floor(Math.random() * PENDING_ID_ALPHABET.length)] ?? '0'
  }
  return id
}

/** Build the visible prompt for one question (header + question). */
function questionPromptText(question: AskUserQuestionItem): string {
  const parts: string[] = []
  if (question.header !== undefined && question.header !== '') parts.push(question.header)
  parts.push(question.question)
  return parts.join('\n\n')
}

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

/** First whitespace-separated token. */
function firstToken(text: string): string {
  return text.split(/\s+/)[0] ?? ''
}

/** First slash token with a possible `@bot` suffix stripped. */
function commandToken(text: string): string {
  const token = firstToken(text)
  const at = token.indexOf('@')
  return at === -1 ? token : token.slice(0, at)
}

/**
 * Rewrite a `//name` invoke to `/name`, keeping the rest of the message.
 * A bare `//` token is not a Skill invoke.
 */
function rewriteSkillInvoke(text: string): string | undefined {
  const command = commandToken(text)
  if (!command.startsWith('//') || command.length <= 2) return undefined
  return `/${command.slice(2)}${text.slice(firstToken(text).length)}`
}

/** Pack names into rows of `columns`. */
function chunkRows<T>(items: readonly T[], columns: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += columns) {
    rows.push([...items.slice(i, i + columns)])
  }
  return rows
}

/** Two-column Skill picker; copies `//name `; pages of 20 with Prev/Next. */
function skillPickerMarkup(names: readonly string[], page = 0): InlineKeyboardMarkup {
  const pageCount = Math.max(1, Math.ceil(names.length / SKILL_PAGE_SIZE))
  const safePage = Math.min(Math.max(page, 0), pageCount - 1)
  const slice = names.slice(safePage * SKILL_PAGE_SIZE, (safePage + 1) * SKILL_PAGE_SIZE)
  const rows: InlineKeyboardButton[][] = chunkRows(slice, SKILL_COLUMNS).map(row =>
    row.map(name => ({
      text: buttonText(name, false),
      copy_text: { text: `//${name} ` },
    })),
  )
  if (names.length > SKILL_PAGE_SIZE) {
    const pager: InlineKeyboardButton[] = []
    if (safePage > 0) pager.push({ text: '‹ Prev', callback_data: `${SKILL_CALLBACK_PREFIX}${safePage - 1}` })
    if (safePage < pageCount - 1) pager.push({ text: 'Next ›', callback_data: `${SKILL_CALLBACK_PREFIX}${safePage + 1}` })
    if (pager.length > 0) rows.push(pager)
  }
  return { inline_keyboard: rows }
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
  private readonly registerQuestionProvider: boolean
  private readonly sleep: (ms: number) => Promise<void>
  private readonly chats = new Map<string, ChatSession>()
  /** Parked sessions keyed by `chatId:workspaceId`; switching away does not dispose them. */
  private readonly parked = new Map<string, ChatSession>()
  private readonly bindings = new Map<string, ChatBinding>()
  private readonly pendingBuckets = new Map<string, ChatPendingBucket>()
  private readonly pendingById = new Map<string, PendingState>()
  private offset: number | undefined
  private stopped = false
  private errorCount = 0
  private disposeEvents: (() => void) | undefined
  private disposeInteractions: (() => void) | undefined

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
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    })
    this.allowedUserIds = options.allowedUserIds ?? []
    this.allowAllUsers = options.allowAllUsers ?? false
    this.provider = options.provider ?? 'deepseek-official'
    this.model = options.model ?? 'deepseek-v4-flash'
    this.maxMessageLength = options.maxMessageLength ?? 4096
    this.preset = options.preset
    this.initAdminUserIds = options.initAdminUserIds ?? []
    this.registerQuestionProvider = options.registerQuestionProvider ?? true
    this.sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  }

  /** Register session/interaction listeners and start the polling loop. */
  start(): void {
    if (this.disposeEvents !== undefined) return
    this.disposeEvents = this.ctx.on('session/event', (session, event) => {
      this.handleSessionEvent(session, event)
    })
    // Defer until sibling plugins (e.g. api-gateway) finish apply; only one
    // userQuestions provider may register — web host wins on duplicate.
    queueMicrotask(() => {
      if (this.stopped || this.disposeInteractions !== undefined) return
      this.disposeInteractions = this.registerInteractions()
    })
    void this.pollLoop()
  }

  /** Stop polling, unregister listeners, cancel pending interactions, dispose agents. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.disposeInteractions !== undefined) {
      this.disposeInteractions()
      this.disposeInteractions = undefined
    }
    if (this.disposeEvents !== undefined) {
      this.disposeEvents()
      this.disposeEvents = undefined
    }
    const agents = [...this.chats.values(), ...this.parked.values()].map(entry => entry.handle)
    this.chats.clear()
    this.parked.clear()
    this.bindings.clear()
    this.pendingBuckets.clear()
    this.pendingById.clear()
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
    if (message.reply_to_message !== undefined) {
      const handled = await this.handleForceReplyMessage(message)
      if (handled) return
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
    if (this.hasBlockingPending(message.chat.id)) {
      await this.safeSend(message.chat.id, PENDING_INTERACTION_TEXT)
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
    const data = query.data
    if (data !== undefined && data.startsWith(USER_QUESTION_CALLBACK_PREFIX)) {
      await this.handleQuestionCallback(query, data)
      return
    }
    if (data !== undefined && data.startsWith(APPROVAL_CALLBACK_PREFIX)) {
      await this.handleApprovalCallback(query, data)
      return
    }
    if (data !== undefined && data.startsWith(SKILL_CALLBACK_PREFIX)) {
      const page = Number(data.slice(SKILL_CALLBACK_PREFIX.length))
      if (!Number.isInteger(page) || page < 0) return
      await this.sendSkillPicker(message.chat.id, { page, edit: message })
      return
    }
    await this.stripButtons(message)
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
    const invoked = rewriteSkillInvoke(text)
    if (invoked !== undefined) {
      const chat = this.chats.get(String(chatId))
      if (chat === undefined) {
        await this.safeSend(chatId, CHOOSE_WORKSPACE_TEXT)
        return
      }
      chat.handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: invoked }],
        source: { kind: 'user' },
      }))
      return
    }
    const command = commandToken(text)
    if (command === '//') {
      const chat = this.chats.get(String(chatId))
      if (chat === undefined) {
        await this.safeSend(chatId, CHOOSE_WORKSPACE_TEXT)
        return
      }
      chat.handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
      return
    }
    switch (command) {
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
      case '/start':
        await this.sendWorkspacePicker(chatId)
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
      case '/skills':
        await this.sendSkillPicker(chatId)
        break
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

  private async sendSkillPicker(chatId: number, options: {
    page?: number
    edit?: TelegramMessage
  } = {}): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    const chat = this.chats.get(String(chatId))
    if (binding === undefined || chat === undefined) {
      await this.safeSend(chatId, CHOOSE_WORKSPACE_TEXT)
      return
    }
    const names = await this.listSkillNames(binding.path, chat.handle.agent)
    if (names === undefined || names.length === 0) {
      await this.safeSend(chatId, NO_SKILL_TEXT)
      return
    }
    const markup = skillPickerMarkup(names, options.page ?? 0)
    const edit = options.edit
    try {
      if (edit !== undefined) {
        await this.client.editMessageText(chatId, edit.message_id, SKILL_PICKER_INTRO, markup)
        return
      }
      await this.client.sendMessage(chatId, SKILL_PICKER_INTRO, undefined, markup)
    } catch (error) {
      if (edit !== undefined) {
        this.ctx.logger.warn('[telegram] editMessageText failed: %s', messageOf(error))
        return
      }
      this.ctx.logger.error('[telegram] delivery failed: %s', messageOf(error))
    }
  }

  /**
   * List user-invocable Skill names for this Workspace. Web mounts
   * `skill-filesystem` on the agent preset layer, so discovery needs the
   * live agent as `scope`; an unscoped host `list({ cwd })` sees none.
   */
  private async listSkillNames(cwd: string, agent: Agent): Promise<string[] | undefined> {
    const skills = (
      agent.ctx.get('skills') ?? this.ctx.get('skills')
    ) as SkillsLike | undefined
    if (skills === undefined) return undefined
    try {
      const listed = await skills.list({ cwd, scope: agent })
      return listed
        .filter(skill => skill.invocation?.userInvocable !== false)
        .map(skill => skill.name)
    } catch (error) {
      this.ctx.logger.warn('[telegram] skill list failed: %s', messageOf(error))
      return undefined
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

  private registerInteractions(): () => void {
    const userQuestions = this.ctx.get('userQuestions') as UserQuestionsLike | undefined
    if (userQuestions === undefined) {
      throw new Error('telegram: missing userQuestions (the composition must provide the user-questions service)')
    }
    if (this.ctx.get('approval') === undefined) {
      throw new Error('telegram: missing approval (the composition must provide the user-approval service)')
    }
    const disposers: Array<() => void> = []
    if (this.registerQuestionProvider) {
      try {
        disposers.push(userQuestions.registerProvider({
          ask: request => this.handleQuestionAsk(request),
        }))
      } catch (error) {
        if (isDuplicateProviderError(error)) {
          this.ctx.logger.info(
            '[telegram] user-questions provider already registered (web host); skipping Telegram question UI',
          )
        } else {
          throw error
        }
      }
    }
    const registerApproval = this.ctx.on.bind(this.ctx) as (
      event: 'approval/request',
      handler: (req: ApprovalRequestLike, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>,
    ) => () => void
    disposers.push(registerApproval('approval/request', (req, next) => {
      return this.handleApprovalRequest(req, next)
    }))
    return () => {
      for (const dispose of disposers) dispose()
      for (const pending of [...this.pendingById.values()]) {
        if (pending.kind === 'question') this.cancelQuestionPending(pending, 'ASK_ABORTED')
        else void this.settleApproval(pending, 'cancelled')
      }
    }
  }

  private handleQuestionAsk(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const agent = request.agent
    if (agent === undefined) {
      return Promise.reject(new BridgeUserQuestionError(
        'telegram user interaction requires an agent-owned session', 'ASK_MISSING_AGENT'))
    }
    const chatId = this.chatIdForAgent(agent)
    if (chatId === undefined) {
      return Promise.reject(new BridgeUserQuestionError(
        'telegram user interaction requires a chat-bound agent session', 'ASK_MISSING_AGENT'))
    }
    if (request.signal?.aborted === true) {
      return Promise.reject(new BridgeUserQuestionError(
        'ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
    }
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const pending: QuestionPendingState = {
        kind: 'question',
        id: generatePendingId(),
        chatId,
        sessionId: String(agent.session.id),
        request,
        resolve,
        reject,
        questions: request.questions,
        answers: new Map(),
        currentQuestionIndex: 0,
        multiSelectSelected: new Set(),
        waitingCustom: false,
      }
      const onAbort = (): void => { this.cancelQuestionPending(pending, 'ASK_ABORTED') }
      pending.onAbort = onAbort
      request.signal?.addEventListener('abort', onAbort, { once: true })
      this.enqueuePending(pending)
    })
  }

  private handleApprovalRequest(
    req: ApprovalRequestLike,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    if (req.signal?.aborted === true) return Promise.resolve('cancelled')
    const chatId = this.chatIdForAgent(req.agent)
    if (chatId === undefined) return next()
    const approvalId = this.findUnclaimedApprovalId(req)
    if (approvalId === undefined) return next()
    return new Promise<ApprovalOutcome>((resolve) => {
      const pending: ApprovalPendingState = {
        kind: 'approval',
        id: generatePendingId(),
        chatId,
        sessionId: String(req.agent.session.id),
        approvalId,
        toolName: req.toolName,
        ...(req.reason === undefined ? {} : { reason: req.reason }),
        ...(req.signal === undefined ? {} : { signal: req.signal }),
        resolve,
      }
      const onAbort = (): void => { this.settleApproval(pending, 'cancelled') }
      pending.onAbort = onAbort
      req.signal?.addEventListener('abort', onAbort, { once: true })
      this.enqueuePending(pending)
    })
  }

  private enqueuePending(pending: PendingState): void {
    const key = String(pending.chatId)
    let bucket = this.pendingBuckets.get(key)
    if (bucket === undefined) {
      bucket = { items: [] }
      this.pendingBuckets.set(key, bucket)
    }
    bucket.items.push(pending)
    this.pendingById.set(pending.id, pending)
    if (bucket.items.length === 1) void this.deliverPendingHead(pending.chatId)
  }

  private async deliverPendingHead(chatId: number): Promise<void> {
    const pending = this.pendingBuckets.get(String(chatId))?.items[0]
    if (pending === undefined) return
    if (pending.kind === 'question') await this.deliverQuestionUI(pending)
    else await this.deliverApprovalUI(pending)
  }

  private finishPending(pending: PendingState): void {
    this.pendingById.delete(pending.id)
    const bucket = this.pendingBuckets.get(String(pending.chatId))
    if (bucket === undefined) return
    if (bucket.items[0] === pending) bucket.items.shift()
    else {
      const index = bucket.items.indexOf(pending)
      if (index >= 0) bucket.items.splice(index, 1)
    }
    if (bucket.items.length === 0) this.pendingBuckets.delete(String(pending.chatId))
    else void this.deliverPendingHead(pending.chatId)
  }

  private hasBlockingPending(chatId: number): boolean {
    const bucket = this.pendingBuckets.get(String(chatId))
    return bucket !== undefined && bucket.items.length > 0
  }

  private chatIdForAgent(agent: Agent): number | undefined {
    return this.chatForSessionId(String(agent.session.id))?.chatId
  }

  private chatForSessionId(sessionId: string): ChatSession | undefined {
    for (const entry of this.chats.values()) {
      if (entry.sessionId === sessionId) return entry
    }
    for (const entry of this.parked.values()) {
      if (entry.sessionId === sessionId) return entry
    }
    return undefined
  }

  private findUnclaimedApprovalId(req: ApprovalRequestLike): string | undefined {
    const events = req.agent.session.events as readonly { type: string, data: Record<string, unknown> }[]
    const claimed = new Set<string>()
    for (const pending of this.pendingById.values()) {
      if (pending.kind === 'approval') claimed.add(pending.approvalId)
    }
    const decided = new Set<string>()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event === undefined) continue
      if (event.type === 'approval/decided') {
        decided.add(String(event.data.id))
      } else if (event.type === 'approval/asked') {
        const id = String(event.data.id)
        if (decided.has(id) || claimed.has(id)) continue
        if ((req.callId ?? null) !== (event.data.callId ?? null)) continue
        return id
      }
    }
    return undefined
  }

  private async deliverQuestionUI(pending: QuestionPendingState): Promise<void> {
    void this.safeAction(pending.chatId, 'typing')
    const question = pending.questions[pending.currentQuestionIndex]
    if (question === undefined) return
    const isPlanReview = question.intent?.kind === 'plan-review'
    const prompt = questionPromptText(question)
    const markup = this.questionMarkup(pending, question)
    if (question.detail !== undefined && question.detail !== '') {
      const chunks = splitMessage(question.detail, this.maxMessageLength)
      if (isPlanReview && chunks.length > 1) {
        await this.safeSend(pending.chatId, '📋 Plan review — parts follow')
      }
      for (let index = 0; index < chunks.length - 1; index += 1) {
        await this.safeSend(pending.chatId, chunks[index] ?? '', 'HTML')
      }
      const lastChunk = chunks[chunks.length - 1] ?? question.detail
      const text = isPlanReview
        ? `${lastChunk}\n\nReview the plan above, then choose:`
        : `${lastChunk}\n\n${prompt}`
      const message = await this.safeSendMarkup(pending.chatId, text, 'HTML', markup)
      pending.anchorMessageId = message.message_id
      pending.anchorPlainText = text
      return
    }
    const message = await this.safeSendMarkup(pending.chatId, prompt, undefined, markup)
    pending.anchorMessageId = message.message_id
    pending.anchorPlainText = prompt
  }

  private async deliverApprovalUI(pending: ApprovalPendingState): Promise<void> {
    void this.safeAction(pending.chatId, 'typing')
    let text = `Allow tool **${pending.toolName}**?`
    if (pending.reason !== undefined && pending.reason !== '') {
      text = `${text}\nReason: ${pending.reason}`
    }
    const markup: InlineKeyboardMarkup = {
      inline_keyboard: [[
        { text: '✓ Allow once', callback_data: `${APPROVAL_CALLBACK_PREFIX}${pending.id}:a` },
        { text: '✗ Reject', callback_data: `${APPROVAL_CALLBACK_PREFIX}${pending.id}:r` },
        { text: '✕ Cancel', callback_data: `${APPROVAL_CALLBACK_PREFIX}${pending.id}:c` },
      ]],
    }
    const message = await this.safeSendMarkup(pending.chatId, text, 'HTML', markup)
    pending.anchorMessageId = message.message_id
    pending.anchorPlainText = text
  }

  private questionMarkup(pending: QuestionPendingState, question: AskUserQuestionItem): InlineKeyboardMarkup {
    const pid = pending.id
    const rows: InlineKeyboardButton[][] = []
    const options = question.options ?? []
    if (question.intent?.kind === 'plan-review') {
      const approveIndex = options.findIndex(option => option.label === question.intent?.approve)
      if (approveIndex >= 0) {
        rows.push([{
          text: `✓ ${question.intent.approve}`,
          callback_data: `${USER_QUESTION_CALLBACK_PREFIX}${pid}:s:${approveIndex}`,
        }])
      }
      rows.push([{ text: '↩ Continue planning', callback_data: `${USER_QUESTION_CALLBACK_PREFIX}${pid}:cu` }])
      rows.push([{ text: '✕ Cancel', callback_data: `${USER_QUESTION_CALLBACK_PREFIX}${pid}:cx` }])
      return { inline_keyboard: rows }
    }
    if (question.multiSelect === true) {
      for (let index = 0; index < options.length; index += 1) {
        const selected = pending.multiSelectSelected.has(index)
        rows.push([{
          text: `${selected ? '☑' : '☐'} ${options[index]?.label ?? ''}`,
          callback_data: `${USER_QUESTION_CALLBACK_PREFIX}${pid}:t:${index}`,
        }])
      }
      rows.push([
        { text: '✓ Confirm', callback_data: `${USER_QUESTION_CALLBACK_PREFIX}${pid}:ok` },
        { text: '✕ Cancel', callback_data: `${USER_QUESTION_CALLBACK_PREFIX}${pid}:cx` },
      ])
      return { inline_keyboard: rows }
    }
    for (let index = 0; index < options.length; index += 1) {
      rows.push([{
        text: options[index]?.label ?? '',
        callback_data: `${USER_QUESTION_CALLBACK_PREFIX}${pid}:s:${index}`,
      }])
    }
    rows.push([{ text: '✏️ Other', callback_data: `${USER_QUESTION_CALLBACK_PREFIX}${pid}:cu` }])
    rows.push([{ text: '✕ Cancel', callback_data: `${USER_QUESTION_CALLBACK_PREFIX}${pid}:cx` }])
    return { inline_keyboard: rows }
  }

  private async handleQuestionCallback(query: TelegramCallbackQuery, data: string): Promise<void> {
    const parts = data.slice(USER_QUESTION_CALLBACK_PREFIX.length).split(':')
    const pid = parts[0]
    const verb = parts[1]
    const arg = parts[2]
    if (pid === undefined || verb === undefined) return
    const pending = this.pendingById.get(pid)
    if (pending === undefined || pending.kind !== 'question') return
    if (this.pendingBuckets.get(String(pending.chatId))?.items[0] !== pending) return
    const question = pending.questions[pending.currentQuestionIndex]
    if (question === undefined) return
    const options = question.options ?? []
    if (verb === 'cx') {
      await this.safeAnswer(query.id, 'Cancelled')
      this.cancelQuestionPending(pending, 'ASK_ABORTED')
      return
    }
    if (verb === 'cu') {
      await this.safeAnswer(query.id)
      pending.waitingCustom = true
      const prompt = question.intent?.kind === 'plan-review' ? FORCE_REPLY_PLAN_PROMPT : FORCE_REPLY_PROMPT
      const reply = await this.safeSendMarkup(pending.chatId, prompt, undefined, { force_reply: true })
      pending.forceReplyMessageId = reply.message_id
      return
    }
    if (verb === 't' && arg !== undefined) {
      const index = Number(arg)
      if (!Number.isInteger(index) || index < 0 || index >= options.length) return
      if (pending.multiSelectSelected.has(index)) pending.multiSelectSelected.delete(index)
      else pending.multiSelectSelected.add(index)
      await this.safeAnswer(query.id, 'Updated')
      if (pending.anchorMessageId !== undefined) {
        const markup = this.questionMarkup(pending, question)
        await this.client.editMessageText(
          pending.chatId,
          pending.anchorMessageId,
          pending.anchorPlainText ?? questionPromptText(question),
          markup,
        )
      }
      return
    }
    if (verb === 'ok') {
      const selected = [...pending.multiSelectSelected]
        .sort((left, right) => left - right)
        .map(index => options[index]?.label)
        .filter((label): label is string => label !== undefined)
      if (selected.length === 0) {
        await this.safeAnswer(query.id, 'Select at least one option')
        return
      }
      await this.safeAnswer(query.id, 'Recorded')
      this.recordQuestionAnswer(pending, { selected })
      return
    }
    if (verb === 's' && arg !== undefined) {
      const index = Number(arg)
      const label = options[index]?.label
      if (!Number.isInteger(index) || label === undefined) return
      await this.safeAnswer(query.id, 'Recorded')
      this.recordQuestionAnswer(pending, { selected: [label] })
    }
  }

  private async handleApprovalCallback(query: TelegramCallbackQuery, data: string): Promise<void> {
    const parts = data.slice(APPROVAL_CALLBACK_PREFIX.length).split(':')
    const pid = parts[0]
    const verb = parts[1]
    if (pid === undefined || verb === undefined) return
    const pending = this.pendingById.get(pid)
    if (pending === undefined || pending.kind !== 'approval') return
    if (this.pendingBuckets.get(String(pending.chatId))?.items[0] !== pending) return
    const outcome: ApprovalOutcome | undefined = verb === 'a'
      ? 'allowed-once'
      : verb === 'r'
        ? 'rejected'
        : verb === 'c'
          ? 'cancelled'
          : undefined
    if (outcome === undefined) return
    const toast = outcome === 'allowed-once' ? 'Allowed' : outcome === 'rejected' ? 'Rejected' : 'Cancelled'
    await this.safeAnswer(query.id, toast)
    await this.settleApproval(pending, outcome)
  }

  private async handleForceReplyMessage(message: TelegramMessage): Promise<boolean> {
    const chatId = message.chat.id
    const bucket = this.pendingBuckets.get(String(chatId))
    const pending = bucket?.items[0]
    if (pending === undefined || pending.kind !== 'question' || !pending.waitingCustom) return false
    if (pending.forceReplyMessageId === undefined) return false
    if (message.reply_to_message?.message_id !== pending.forceReplyMessageId) return false
    const text = message.text?.trim()
    if (text === undefined || text === '') {
      await this.safeSend(chatId, 'Please enter a non-empty answer.')
      return true
    }
    pending.waitingCustom = false
    this.recordQuestionAnswer(pending, { selected: [], custom: text })
    return true
  }

  private recordQuestionAnswer(
    pending: QuestionPendingState,
    answer: { selected: string[], custom?: string },
  ): void {
    const question = pending.questions[pending.currentQuestionIndex]
    if (question === undefined) return
    pending.answers.set(question.id, answer)
    pending.currentQuestionIndex += 1
    pending.multiSelectSelected.clear()
    pending.waitingCustom = false
    pending.forceReplyMessageId = undefined
    if (pending.currentQuestionIndex < pending.questions.length) {
      void this.deliverQuestionUI(pending)
      return
    }
    void this.completeQuestionPending(pending)
  }

  private async completeQuestionPending(pending: QuestionPendingState): Promise<void> {
    if (pending.anchorMessageId !== undefined) {
      await this.finalizeAnchor(pending.chatId, pending.anchorMessageId, pending.anchorPlainText ?? '', '✓ Answered')
    }
    const answers: AskUserQuestionAnswerItem[] = pending.questions.map((question) => {
      const stored = pending.answers.get(question.id) ?? { selected: [] }
      return {
        id: question.id,
        selected: stored.selected,
        ...(stored.custom === undefined ? {} : { custom: stored.custom }),
      }
    })
    if (pending.onAbort !== undefined) {
      pending.request.signal?.removeEventListener('abort', pending.onAbort)
    }
    pending.resolve({ answers })
    this.finishPending(pending)
  }

  private cancelQuestionPending(pending: QuestionPendingState, code: string): void {
    void this.finalizeAnchor(
      pending.chatId,
      pending.anchorMessageId,
      pending.anchorPlainText ?? '',
      '✕ Cancelled',
    )
    if (pending.onAbort !== undefined) {
      pending.request.signal?.removeEventListener('abort', pending.onAbort)
    }
    pending.reject(new BridgeUserQuestionError('ask_user_question was aborted before the user answered', code))
    this.finishPending(pending)
  }

  private async settleApproval(pending: ApprovalPendingState, outcome: ApprovalOutcome): Promise<void> {
    if (!this.pendingById.has(pending.id)) return
    const suffix = outcome === 'allowed-once'
      ? '✓ Allowed once'
      : outcome === 'rejected'
        ? '✗ Rejected'
        : '✕ Cancelled'
    await this.finalizeAnchor(pending.chatId, pending.anchorMessageId, pending.anchorPlainText ?? '', suffix)
    if (pending.onAbort !== undefined) {
      pending.signal?.removeEventListener('abort', pending.onAbort)
    }
    pending.resolve(outcome)
    this.finishPending(pending)
  }

  private async finalizeAnchor(
    chatId: number,
    messageId: number | undefined,
    text: string,
    suffix: string,
  ): Promise<void> {
    if (messageId === undefined) return
    try {
      await this.client.editMessageText(chatId, messageId, `${text}\n\n${suffix}`, { inline_keyboard: [] })
    } catch (error) {
      this.ctx.logger.warn('[telegram] editMessageText failed: %s', messageOf(error))
    }
  }

  /** Escape text for Telegram HTML tag bodies (not full markdown). */
  private async safeSendMarkup(
    chatId: number,
    text: string,
    parseMode?: 'HTML',
    replyMarkup?: ReplyMarkup,
  ): Promise<TelegramMessage> {
    try {
      const body = parseMode === 'HTML' ? markdownToHtml(text) : text
      return await this.client.sendMessage(chatId, body, parseMode, replyMarkup)
    } catch (error) {
      if (parseMode === 'HTML') {
        return await this.client.sendMessage(chatId, text, undefined, replyMarkup)
      }
      throw error
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
