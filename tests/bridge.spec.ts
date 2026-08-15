import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { TelegramBridge } from '../src/bridge.ts'
import type { TelegramBridgeOptions } from '../src/bridge.ts'
import type { BotCommand, InlineKeyboardMarkup, TelegramClientLike, TelegramUpdate } from '../src/client.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

interface FakeAgent {
  session: { id: string }
  followup: ReturnType<typeof vi.fn>
  ctx: { get: Mock }
}

interface FakeHandle {
  agent: FakeAgent
  dispose: ReturnType<typeof vi.fn>
}

let current: Harness | undefined
afterEach(async () => {
  await current?.bridge.stop()
  current = undefined
})

type Mock = ReturnType<typeof vi.fn>

interface CreateCall {
  sessionId: string
  meta?: { cwd?: string; agentPreset?: string }
  setup?: (agentCtx: Context) => Promise<void>
}

interface Harness {
  bridge: TelegramBridge
  client: TelegramClientLike & {
    getMe: Mock
    getUpdates: Mock
    sendMessage: Mock
    sendChatAction: Mock
    editMessageText: Mock
    answerCallbackQuery: Mock
    setMyCommands: Mock
    getMyCommands: Mock
  }
  ctx: {
    on: Mock
    agents: { create: Mock }
    logger: { warn: Mock; error: Mock }
    get: Mock
  }
  agents: FakeHandle[]
  creates: CreateCall[]
  presets: { resolve: Mock; mount: Mock }
  attachSession: Mock
  workspaces: { id: string, path: string, title: string, attachSession: Mock }[]
  sent: { chatId: number, text: string, parseMode?: 'HTML', replyMarkup?: InlineKeyboardMarkup }[]
  edits: { chatId: number, messageId: number, text: string, replyMarkup?: InlineKeyboardMarkup }[]
  answers: { callbackQueryId: string, text?: string }[]
  actions: { chatId: number; action: string }[]
  polls: (number | undefined)[]
  sleeps: number[]
  emit(sessionId: string, event: SessionEvent): void
}

interface HarnessSeams {
  /** Default: a fake that resolves `preset ?? 'standard'`. `missing` omits the service. */
  agentPresets?: 'default' | 'missing'
  /** Default: two fake workspaces. `missing` omits the registry; `throwing` rejects attach; `empty` lists none. */
  workspaceRegistry?: 'default' | 'missing' | 'throwing' | 'empty'
  /** Default: two user-invocable skills. `missing` omits the service; `empty` lists none; `many` is 21 names. */
  skills?: 'default' | 'missing' | 'empty' | 'many'
}

/** Poll an async condition for up to five seconds. */
async function waitFor<T>(get: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 5000
  for (;;) {
    const value = get()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** Drain asynchronous work before a negative assertion. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 25))
}

function createHarness(options: Partial<TelegramBridgeOptions> = {}, seams: HarnessSeams = {}): Harness {
  const sent: Harness['sent'] = []
  const edits: Harness['edits'] = []
  const answers: Harness['answers'] = []
  const actions: Harness['actions'] = []
  const polls: Harness['polls'] = []
  const sleeps: Harness['sleeps'] = []
  const agents: FakeHandle[] = []
  const creates: CreateCall[] = []
  const attachSession = vi.fn(async (_id: string) => {})
  const presets = {
    resolve: vi.fn(async (id?: string) => ({ id: id ?? 'standard' })),
    mount: vi.fn(async () => {}),
  }
  const workspaces = [
    { id: 'ws-obsidian', path: 'D:\\codehouse\\obsidian', title: 'obsidian', attachSession },
    { id: 'ws-telegram', path: 'D:\\codehouse\\telegram', title: 'telegram', attachSession },
  ]
  const registry = {
    list: vi.fn(() => seams.workspaceRegistry === 'empty' ? [] : workspaces),
    get: vi.fn((id: string) => workspaces.find(workspace => workspace.id === id)),
  }
  if (seams.workspaceRegistry === 'throwing') {
    attachSession.mockRejectedValue(new Error('attach failed'))
  }
  const skillCatalog = [
    { name: 'tdd', invocation: { userInvocable: true, modelInvocable: true } },
    { name: 'code-review', invocation: { userInvocable: true, modelInvocable: true } },
    { name: 'hidden', invocation: { userInvocable: false, modelInvocable: true } },
  ]
  const manySkills = Array.from({ length: 21 }, (_, i) => ({
    name: `skill-${String(i).padStart(2, '0')}`,
    invocation: { userInvocable: true, modelInvocable: true },
  }))
  const skills = {
    list: vi.fn(async (_options?: { cwd?: string }) => {
      if (seams.skills === 'empty') return []
      if (seams.skills === 'many') return manySkills
      return skillCatalog
    }),
  }
  let listener: ((session: { id: string }, event: SessionEvent) => void) | undefined
  let menu: BotCommand[] = []
  const client: TelegramClientLike & {
    getMe: Mock
    getUpdates: Mock
    sendMessage: Mock
    sendChatAction: Mock
    editMessageText: Mock
    answerCallbackQuery: Mock
    setMyCommands: Mock
    getMyCommands: Mock
  } = {
    getMe: vi.fn(async () => ({ id: 1, is_bot: true })),
    getUpdates: vi.fn(async (offset?: number) => { polls.push(offset); return [] as TelegramUpdate[] }),
    sendMessage: vi.fn(async (chatId: number, text: string, parseMode?: 'HTML', replyMarkup?: InlineKeyboardMarkup) => {
      sent.push({
        chatId,
        text,
        ...(parseMode === undefined ? {} : { parseMode }),
        ...(replyMarkup === undefined ? {} : { replyMarkup }),
      })
      return { message_id: sent.length, chat: { id: chatId, type: 'private' }, text, date: 0 }
    }),
    sendChatAction: vi.fn(async (chatId: number, action: string) => {
      actions.push({ chatId, action })
      return true
    }),
    editMessageText: vi.fn(async (chatId: number, messageId: number, text: string, replyMarkup?: InlineKeyboardMarkup) => {
      edits.push({
        chatId,
        messageId,
        text,
        ...(replyMarkup === undefined ? {} : { replyMarkup }),
      })
      return { message_id: messageId, chat: { id: chatId, type: 'private' }, text, date: 0 }
    }),
    answerCallbackQuery: vi.fn(async (callbackQueryId: string, text?: string) => {
      answers.push(text === undefined ? { callbackQueryId } : { callbackQueryId, text })
      return true
    }),
    setMyCommands: vi.fn(async (commands: readonly BotCommand[]) => {
      menu = [...commands]
      return true
    }),
    getMyCommands: vi.fn(async () => menu),
  }
  const ctx: {
    on: Mock
    agents: { create: Mock }
    logger: { warn: Mock; error: Mock }
    get: Mock
  } = {
    on: vi.fn((_event: string, l: typeof listener) => {
      listener = l
      return () => { listener = undefined }
    }),
    agents: {
      create: vi.fn(async (opts: CreateCall) => {
        creates.push(opts)
        const handle: FakeHandle = {
          agent: {
            session: { id: opts.sessionId },
            followup: vi.fn(),
            ctx: { get: (name: string) => ctx.get(name) },
          },
          dispose: vi.fn(),
        }
        agents.push(handle)
        return handle
      }),
    },
    logger: { warn: vi.fn(), error: vi.fn() },
    get: vi.fn((name: string) => {
      if (name === 'agentPresets') return seams.agentPresets === 'missing' ? undefined : presets
      if (name === 'workspaceRegistry') return seams.workspaceRegistry === 'missing' ? undefined : registry
      if (name === 'skills') return seams.skills === 'missing' ? undefined : skills
      return undefined
    }),
  }
  const bridge = new TelegramBridge(ctx as unknown as Context, {
    token: 't:ok',
    client,
    sleep: async (ms: number) => { sleeps.push(ms); await new Promise(resolve => setTimeout(resolve, ms)) },
    // Most tests exercise message flow; the authorization tests opt out.
    allowAllUsers: true,
    ...options,
  })
  const harness: Harness = {
    bridge,
    client,
    ctx,
    agents,
    creates,
    presets,
    attachSession,
    workspaces,
    sent,
    edits,
    answers,
    actions,
    polls,
    sleeps,
    emit(sessionId: string, event: SessionEvent): void {
      listener?.({ id: sessionId }, event)
    },
  }
  current = harness
  return harness
}

function update(message: Partial<{ chatId: number; fromId: number; text: string; updateId: number }> = {}): TelegramUpdate {
  return {
    update_id: message.updateId ?? 1,
    message: {
      message_id: 1,
      chat: { id: message.chatId ?? 7, type: 'private' },
      from: { id: message.fromId ?? 42 },
      ...(message.text === undefined ? {} : { text: message.text }),
      date: 0,
    },
  }
}

function callbackUpdate(query: Partial<{
  chatId: number
  fromId: number
  data: string
  messageId: number
  text: string
  updateId: number
  callbackId: string
}> = {}): TelegramUpdate {
  const chatId = query.chatId ?? 7
  return {
    update_id: query.updateId ?? 1,
    callback_query: {
      id: query.callbackId ?? 'cb1',
      from: { id: query.fromId ?? 42 },
      data: query.data ?? 'ws:ws-obsidian',
      message: {
        message_id: query.messageId ?? 10,
        chat: { id: chatId, type: 'private' },
        text: query.text ?? 'Choose a workspace.',
        date: 0,
      },
    },
  }
}

/** Bind chat 7 to the default obsidian Workspace so later messages have a session. */
async function bindDefaultWorkspace(h: Harness, updateId = 1): Promise<void> {
  const before = h.agents.length
  h.client.getUpdates.mockResolvedValueOnce([callbackUpdate({ updateId })])
  await waitFor(() => h.agents.length > before ? true : undefined, 'workspace bound')
}

describe('TelegramBridge', () => {
  it('start registers the session listener and begins polling', async () => {
    const h = createHarness()
    h.bridge.start()
    expect(h.ctx.on).toHaveBeenCalledWith('session/event', expect.any(Function))
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'first poll')
  })

  it('forwards a text message to the chat agent as a user message', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'hello', updateId: 2 })])
    await waitFor(() => h.agents[0]?.agent.followup.mock.calls.length === 1 ? true : undefined, 'followup')
    const message = h.agents[0]?.agent.followup.mock.calls[0]?.[0] as { content: { text: string }[] }
    expect(message.content[0]?.text).toBe('hello')
  })

  it('advances the polling offset and reuses the chat agent', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    h.client.getUpdates.mockResolvedValueOnce([
      update({ text: 'one', updateId: 2 }),
      { update_id: 3, message: { message_id: 2, chat: { id: 7, type: 'private' }, from: { id: 42 }, text: 'two', date: 0 } },
    ])
    await waitFor(() => h.agents[0]?.agent.followup.mock.calls.length === 2 ? true : undefined, 'both followups')
    expect(h.agents.length).toBe(1)
    await waitFor(() => h.polls.some(offset => offset === 4) ? true : undefined, 'offset advanced')
  })

  it('denies unauthorized users with a notice', async () => {
    const h = createHarness({ allowAllUsers: false, allowedUserIds: [1] })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'hello', fromId: 42 })])
    await waitFor(() => h.sent.length > 0 ? true : undefined, 'denial sent')
    expect(h.sent[0]).toMatchObject({ chatId: 7, text: 'Access denied.' })
    expect(h.agents.length).toBe(0)
  })

  it('allowAllUsers bypasses the allowlist', async () => {
    const h = createHarness({ allowAllUsers: true })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([callbackUpdate({ fromId: 99 })])
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'agent created')
  })

  it('ignores updates without a message or text', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([
      { update_id: 1 },
      { update_id: 2, message: { message_id: 2, chat: { id: 7, type: 'private' }, date: 0 } },
      { update_id: 3, message: { message_id: 3, chat: { id: 7, type: 'private' }, from: { id: 42 }, text: 'hi', date: 0 } },
    ])
    // The text update proves the batch was consumed: the no-message and
    // no-text updates are ignored; unbound text asks the user to /start.
    await waitFor(() => h.sent.some(s => s.text === 'Choose a workspace first with /start.') ? true : undefined, 'text update processed')
    await settle()
    expect(h.agents.length).toBe(0)
  })

  it('/start lists workspaces and does not create a session', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/start' })])
    await waitFor(() => h.sent.some(s => s.text.includes('Choose a workspace.')) ? true : undefined, 'picker sent')
    expect(h.agents.length).toBe(0)
    expect(h.sent[0]?.replyMarkup?.inline_keyboard).toEqual([
      [{ text: 'obsidian', callback_data: 'ws:ws-obsidian' }],
      [{ text: 'telegram', callback_data: 'ws:ws-telegram' }],
    ])
    expect(h.sent[0]?.text).toBe('Choose a workspace.')
    expect(h.sent[0]?.text).not.toContain('D:\\codehouse\\')
  })

  it('/clear rotates the session agent and disposes the previous one', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    const first = h.agents[0]!
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/clear', updateId: 2 })])
    await waitFor(() => h.agents.length === 2 ? true : undefined, 'second agent')
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(h.creates[1]?.meta?.cwd).toBe('D:\\codehouse\\obsidian')
    // Old-session events no longer deliver.
    h.emit(first.agent.session.id, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'stale' }] } } } as SessionEvent)
    await settle()
    expect(h.sent.some(s => s.text === 'stale')).toBe(false)
  })

  it('/new is an unknown command', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/new' })])
    await waitFor(() => h.sent.some(s => s.text.includes('Unknown command /new')) ? true : undefined, 'unknown reply')
    expect(h.agents.length).toBe(0)
  })

  it('/help lists the commands', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/help' })])
    await waitFor(() => h.sent.some(s => s.text.includes('/start')) ? true : undefined, 'help sent')
    expect(h.sent[0]?.text).toContain('/skills')
    expect(h.sent[0]?.text).not.toContain('/init')
    expect(h.sent[0]?.text).not.toContain('/new')
  })

  it('does not register the Command Menu on start', async () => {
    const h = createHarness({ initAdminUserIds: [42] })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await settle()
    expect(h.client.setMyCommands).not.toHaveBeenCalled()
  })

  it('/init as an Init Admin registers the Command Menu', async () => {
    const h = createHarness({ allowAllUsers: false, allowedUserIds: [42], initAdminUserIds: [42] })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/init', fromId: 42 })])
    await waitFor(() => h.sent.some(s => s.text === 'Initialized the command menu.') ? true : undefined, 'init success')
    await expect(h.client.getMyCommands()).resolves.toEqual([
      { command: 'start', description: 'choose a workspace and start a session' },
      { command: 'clear', description: 'reset the current session' },
      { command: 'skills', description: 'choose a skill' },
      { command: 'help', description: 'show this help' },
    ])
    expect(h.agents.length).toBe(0)
  })

  it('/init with an empty Init Admin list is an unknown command', async () => {
    const h = createHarness({ allowAllUsers: true })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/init' })])
    await waitFor(() => h.sent.some(s => s.text.includes('Unknown command /init')) ? true : undefined, 'unknown reply')
    expect(h.client.setMyCommands).not.toHaveBeenCalled()
  })

  it('/init from an authorized non-admin is an unknown command', async () => {
    const h = createHarness({ allowAllUsers: false, allowedUserIds: [42], initAdminUserIds: [99] })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/init', fromId: 42 })])
    await waitFor(() => h.sent.some(s => s.text.includes('Unknown command /init')) ? true : undefined, 'unknown reply')
    expect(h.client.setMyCommands).not.toHaveBeenCalled()
  })

  it('/init reports failure without the API description when setMyCommands throws', async () => {
    const h = createHarness({ allowAllUsers: true, initAdminUserIds: [42] })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.setMyCommands.mockRejectedValueOnce(new Error('telegram setMyCommands failed: Bad Request for bott:ok'))
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/init', fromId: 42 })])
    await waitFor(() => h.sent.some(s => s.text === 'Failed to initialize the command menu.') ? true : undefined, 'init failure')
    expect(h.sent.some(s => s.text.includes('Bad Request') || s.text.includes('t:ok'))).toBe(false)
    expect(h.ctx.logger.error.mock.calls.some((call: unknown[]) => String(call[0]).includes('setMyCommands failed'))).toBe(true)
  })

  it('rewrites a //skill invoke and forwards /name to the agent', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '//code-review fix the tests', updateId: 2 })])
    await waitFor(() => h.agents[0]?.agent.followup.mock.calls.length === 1 ? true : undefined, 'skill followup')
    const message = h.agents[0]?.agent.followup.mock.calls[0]?.[0] as { content: { text: string }[] }
    expect(message.content[0]?.text).toBe('/code-review fix the tests')
  })

  it('does not treat //start as the /start command', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '//start', updateId: 2 })])
    await waitFor(() => h.agents[0]?.agent.followup.mock.calls.length === 1 ? true : undefined, 'followup')
    const message = h.agents[0]?.agent.followup.mock.calls[0]?.[0] as { content: { text: string }[] }
    expect(message.content[0]?.text).toBe('/start')
    expect(h.sent.some(s => s.text === 'Choose a workspace.')).toBe(false)
  })

  it('forwards a bare // token without rewriting', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '// just text', updateId: 2 })])
    await waitFor(() => h.agents[0]?.agent.followup.mock.calls.length === 1 ? true : undefined, 'followup')
    const message = h.agents[0]?.agent.followup.mock.calls[0]?.[0] as { content: { text: string }[] }
    expect(message.content[0]?.text).toBe('// just text')
  })

  it('treats a single-slash non-bridge command as unknown', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/code-review', updateId: 2 })])
    await waitFor(() => h.sent.some(s => s.text.includes('Unknown command /code-review')) ? true : undefined, 'unknown reply')
    expect(h.agents[0]?.agent.followup).not.toHaveBeenCalled()
  })

  it('delivers assistant text as split HTML messages', async () => {
    const h = createHarness({ maxMessageLength: 12 })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    const long = 'a'.repeat(30)
    const before = h.sent.length
    h.emit(h.agents[0]!.agent.session.id, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: long }] } },
    } as SessionEvent)
    await waitFor(() => h.sent.length >= before + 3 ? true : undefined, 'chunks delivered')
    const chunks = h.sent.slice(before)
    expect(chunks.map(s => s.text).join('')).toBe(long)
    expect(chunks.every(s => s.parseMode === 'HTML')).toBe(true)
  })

  it('ignores assistant messages without text blocks', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    const before = h.sent.length
    h.emit(h.agents[0]!.agent.session.id, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'tool', id: 't' }] } },
    } as SessionEvent)
    await settle()
    expect(h.sent.length).toBe(before)
  })

  it('falls back to plain text when HTML delivery is rejected', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    const sendCallsBefore = h.client.sendMessage.mock.calls.length
    h.client.sendMessage
      .mockRejectedValueOnce(new Error('can\'t parse entities'))
      .mockResolvedValue({ message_id: 1, chat: { id: 7, type: 'private' }, date: 0 })
    h.emit(h.agents[0]!.agent.session.id, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '<b>hi</b>' }] } },
    } as SessionEvent)
    await waitFor(() => h.client.sendMessage.mock.calls.length >= sendCallsBefore + 2 ? true : undefined, 'fallback sent')
    const first = h.client.sendMessage.mock.calls[sendCallsBefore] as [number, string, 'HTML' | undefined]
    const second = h.client.sendMessage.mock.calls[sendCallsBefore + 1] as [number, string, 'HTML' | undefined]
    expect(first).toEqual([7, '&lt;b&gt;hi&lt;/b&gt;', 'HTML'])
    expect(second).toEqual([7, '<b>hi</b>'])
  })

  it('logs a delivery failure when the plain-text fallback also fails', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    h.client.sendMessage.mockRejectedValue(new Error('network down'))
    h.emit(h.agents[0]!.agent.session.id, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'hello' }] } },
    } as SessionEvent)
    await waitFor(() => h.ctx.logger.error.mock.calls.length > 0 ? true : undefined, 'error logged')
  })

  it('logs a plain-text delivery failure from the command path', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.sendMessage.mockRejectedValue(new Error('down'))
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/help' })])
    await waitFor(() => h.ctx.logger.error.mock.calls.length > 0 ? true : undefined, 'delivery error logged')
    expect(h.ctx.logger.error.mock.calls[0]?.[0]).toBe('[telegram] delivery failed: %s')
  })

  it('logs a failed typing action without breaking the turn', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    h.client.sendChatAction.mockRejectedValue(new Error('action down'))
    h.emit(h.agents[0]!.agent.session.id, { type: 'turn/start', data: {} } as SessionEvent)
    await waitFor(() => h.ctx.logger.warn.mock.calls.length > 0 ? true : undefined, 'action warning logged')
    expect(h.ctx.logger.warn.mock.calls[0]?.[0]).toBe('[telegram] chat action %s failed: %s')
  })

  it('sends the typing action on turn start', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    h.emit(h.agents[0]!.agent.session.id, { type: 'turn/start', data: {} } as SessionEvent)
    await waitFor(() => h.actions.length === 1 ? true : undefined, 'typing sent')
    expect(h.actions[0]).toEqual({ chatId: 7, action: 'typing' })
  })

  it('ignores non-delivery event kinds on known sessions', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    const sentBefore = h.sent.length
    const actionsBefore = h.actions.length
    h.emit(h.agents[0]!.agent.session.id, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent)
    await settle()
    expect(h.sent.length).toBe(sentBefore)
    expect(h.actions.length).toBe(actionsBefore)
  })

  it('ignores session events from foreign sessions', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.emit('other-session', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } } as SessionEvent)
    await settle()
    expect(h.sent.length).toBe(0)
    expect(h.actions.length).toBe(0)
  })

  it('backs off with a warning when polling fails and retries', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockRejectedValueOnce('boom')
    await waitFor(() => h.ctx.logger.warn.mock.calls.length > 0 ? true : undefined, 'warning logged')
    await waitFor(() => h.polls.length >= 2 ? true : undefined, 'retry poll')
    expect(h.sleeps).toContain(1000)
  })

  it('logs and continues when an update handler fails', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.ctx.agents.create.mockRejectedValue(new Error('no adapter'))
    h.client.getUpdates.mockResolvedValueOnce([callbackUpdate()])
    await waitFor(() => h.ctx.logger.error.mock.calls.length > 0 ? true : undefined, 'update error logged')
    const [format, id, reason] = h.ctx.logger.error.mock.calls[0] as [string, number, string]
    expect(format).toContain('update %d failed')
    expect(id).toBe(1)
    expect(reason).toBe('no adapter')
  })

  it('stop disposes agents, unregisters the listener, and ends polling', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    await h.bridge.stop()
    const pollCount = h.polls.length
    await settle()
    expect(h.agents[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(h.polls.length).toBe(pollCount)
    expect(h.ctx.on.mock.results[0]?.value).toBeTypeOf('function')
  })

  it('start is idempotent', async () => {
    const h = createHarness()
    h.bridge.start()
    h.bridge.start()
    expect(h.ctx.on).toHaveBeenCalledTimes(1)
    await h.bridge.stop()
  })

  it('runs the production default sleep cadence with a client seam', async () => {
    const client = {
      getMe: vi.fn(async () => ({ id: 1, is_bot: true })),
      getUpdates: vi.fn(async () => [] as TelegramUpdate[]),
      sendMessage: vi.fn(async () => ({ message_id: 1, chat: { id: 7, type: 'private' }, date: 0 })),
      sendChatAction: vi.fn(async () => true),
      editMessageText: vi.fn(async () => ({ message_id: 1, chat: { id: 7, type: 'private' }, date: 0 })),
      answerCallbackQuery: vi.fn(async () => true),
      setMyCommands: vi.fn(async () => true),
      getMyCommands: vi.fn(async () => []),
    }
    const ctx = {
      on: () => () => {},
      agents: { create: vi.fn() },
      logger: { warn: vi.fn(), error: vi.fn() },
      get: vi.fn(() => undefined),
    }
    const bridge = new TelegramBridge(ctx as unknown as Context, { token: 't:ok', client })
    bridge.start()
    await new Promise(resolve => setTimeout(resolve, 120))
    await bridge.stop()
  })

  it('constructs the production client with and without an explicit polling timeout', () => {
    const withTimeout = new TelegramBridge({} as unknown as Context, { token: 't:ok', pollingTimeoutSec: 5 })
    const defaulted = new TelegramBridge({} as unknown as Context, { token: 't:ok' })
    expect(withTimeout).toBeInstanceOf(TelegramBridge)
    expect(defaulted).toBeInstanceOf(TelegramBridge)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a non-array object', { ok: true }],
  ] as const)('logs and keeps polling when getUpdates resolves with %s', async (_label, malformed) => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce(malformed as unknown as TelegramUpdate[])
    await waitFor(() => h.ctx.logger.warn.mock.calls.some((call: unknown[]) => String(call[0]).includes('malformed getUpdates')) ? true : undefined, 'malformed response logged')
    await waitFor(() => h.polls.length >= 2 ? true : undefined, 'polling resumed')
    expect(h.agents.length).toBe(0)
    expect(h.sent.length).toBe(0)
  })

  it('skips malformed updates inside a batch and keeps processing the rest', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([
      null as unknown as TelegramUpdate,
      callbackUpdate({ updateId: 2 }),
    ])
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'valid update processed')
    expect(h.ctx.logger.warn.mock.calls.some((call: unknown[]) => String(call[0]).includes('skipped malformed update'))).toBe(true)
  })

  it('drops an in-flight batch that resolves after stop', async () => {
    const h = createHarness()
    let resolveUpdates: ((updates: TelegramUpdate[]) => void) | undefined
    h.client.getUpdates.mockImplementationOnce((offset?: number) => {
      h.polls.push(offset)
      return new Promise<TelegramUpdate[]>(resolve => { resolveUpdates = resolve })
    })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'poll in flight')
    await h.bridge.stop()
    resolveUpdates?.([update({ text: 'late' })])
    await settle()
    expect(h.agents.length).toBe(0)
    expect(h.sent.length).toBe(0)
    expect(h.client.getUpdates).toHaveBeenCalledTimes(1)
  })

  it('mounts the resolved preset and attaches the session on first pick', async () => {
    const h = createHarness({ preset: 'coding', cwd: 'D:\\ignored-config-cwd' })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    expect(h.presets.resolve).toHaveBeenCalledWith('coding')
    expect(h.creates[0]?.meta).toEqual({ cwd: 'D:\\codehouse\\obsidian', agentPreset: 'coding' })
    expect(h.creates[0]?.setup).toBeTypeOf('function')
    await h.creates[0]!.setup!({} as Context)
    expect(h.presets.mount).toHaveBeenCalledWith({}, 'coding')
    await waitFor(() => h.attachSession.mock.calls.length === 1 ? true : undefined, 'workspace attached')
    expect(h.attachSession).toHaveBeenCalledWith(h.agents[0]!.agent.session.id)
  })

  it('remounts the preset and reattaches on /clear', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/clear', updateId: 2 })])
    await waitFor(() => h.agents.length === 2 ? true : undefined, 'second agent')
    expect(h.creates).toHaveLength(2)
    expect(h.creates[1]?.meta).toEqual({ cwd: 'D:\\codehouse\\obsidian', agentPreset: 'standard' })
    expect(h.creates[1]?.setup).toBeTypeOf('function')
    await waitFor(() => h.attachSession.mock.calls.length === 2 ? true : undefined, 'both sessions attached')
  })

  it('still delivers when workspace attach fails', async () => {
    const h = createHarness({}, { workspaceRegistry: 'throwing' })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    await waitFor(() => h.ctx.logger.warn.mock.calls.some((call: unknown[]) => String(call[0]).includes('workspace attach failed')) ? true : undefined, 'attach warning')
    expect(h.sent.some(s => s.text === 'The session could not be attached to this workspace. It is still available.')).toBe(true)
    h.emit(h.agents[0]!.agent.session.id, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'pong' }] } },
    } as SessionEvent)
    await waitFor(() => h.sent.some(s => s.text === 'pong') ? true : undefined, 'reply delivered')
  })

  it('does not create a session when the registry is absent', async () => {
    const h = createHarness({}, { workspaceRegistry: 'missing' })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/start' })])
    await waitFor(() => h.sent.some(s => s.text === 'No workspaces are available. Create one in DeepSeek Harness first.') ? true : undefined, 'empty notice')
    expect(h.agents.length).toBe(0)
    expect(h.attachSession).not.toHaveBeenCalled()
  })

  it('prompts to choose a workspace before a text message is handled', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'hello' })])
    await waitFor(() => h.sent.some(s => s.text === 'Choose a workspace first with /start.') ? true : undefined, 'prompt sent')
    expect(h.agents.length).toBe(0)
  })

  it('/clear without a binding prompts to choose a workspace', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/clear' })])
    await waitFor(() => h.sent.some(s => s.text === 'Choose a workspace first with /start.') ? true : undefined, 'prompt sent')
    expect(h.agents.length).toBe(0)
  })

  it('/start with an empty workspace list does not create a session', async () => {
    const h = createHarness({}, { workspaceRegistry: 'empty' })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/start' })])
    await waitFor(() => h.sent.some(s => s.text === 'No workspaces are available. Create one in DeepSeek Harness first.') ? true : undefined, 'empty notice')
    expect(h.agents.length).toBe(0)
  })

  it('picking a workspace creates a session, strips buttons, and welcomes', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([callbackUpdate({ messageId: 10, text: 'Choose a workspace.' })])
    await waitFor(() => h.sent.some(s => s.text.includes('Hello')) ? true : undefined, 'welcome sent')
    expect(h.creates[0]?.meta?.cwd).toBe('D:\\codehouse\\obsidian')
    expect(h.sent.some(s => s.text === 'Using workspace: obsidian\nD:\\codehouse\\obsidian')).toBe(true)
    expect(h.edits[0]).toMatchObject({ chatId: 7, messageId: 10, replyMarkup: { inline_keyboard: [] } })
    expect(h.answers[0]).toEqual({ callbackQueryId: 'cb1' })
  })

  it('picking the same workspace keeps the current session', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    expect(h.agents.length).toBe(1)
    h.client.getUpdates.mockResolvedValueOnce([callbackUpdate({ updateId: 2, callbackId: 'cb2' })])
    await waitFor(() => h.sent.filter(s => s.text.startsWith('Using workspace:')).length === 2 ? true : undefined, 'second confirm')
    expect(h.agents.length).toBe(1)
    expect(h.sent.filter(s => s.text.includes('Hello')).length).toBe(1)
  })

  it('picking a different workspace parks the previous session', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    const first = h.agents[0]!
    h.client.getUpdates.mockResolvedValueOnce([callbackUpdate({ updateId: 2, data: 'ws:ws-telegram', callbackId: 'cb2' })])
    await waitFor(() => h.agents.length === 2 ? true : undefined, 'second agent')
    expect(first.dispose).not.toHaveBeenCalled()
    expect(h.creates[1]?.meta?.cwd).toBe('D:\\codehouse\\telegram')
    expect(h.sent.some(s => s.text === 'Using workspace: telegram\nD:\\codehouse\\telegram')).toBe(true)
    expect(h.sent.filter(s => s.text.includes('Hello')).length).toBe(2)
  })

  it('picking a previously used workspace restores the parked session', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    const first = h.agents[0]!
    h.client.getUpdates.mockResolvedValueOnce([callbackUpdate({ updateId: 2, data: 'ws:ws-telegram', callbackId: 'cb2' })])
    await waitFor(() => h.agents.length === 2 ? true : undefined, 'second agent')
    h.client.getUpdates.mockResolvedValueOnce([callbackUpdate({ updateId: 3, data: 'ws:ws-obsidian', callbackId: 'cb3' })])
    await waitFor(() => h.sent.filter(s => s.text === 'Using workspace: obsidian\nD:\\codehouse\\obsidian').length === 2 ? true : undefined, 'restored confirm')
    expect(h.agents.length).toBe(2)
    expect(first.dispose).not.toHaveBeenCalled()
    expect(h.creates.length).toBe(2)
    expect(h.sent.filter(s => s.text.includes('Hello')).length).toBe(2)
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'back', updateId: 4 })])
    await waitFor(() => first.agent.followup.mock.calls.length === 1 ? true : undefined, 'restored followup')
  })

  it('marks the current workspace on a later /start list', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/start', updateId: 2 })])
    await waitFor(() => h.sent.filter(s => s.replyMarkup !== undefined).length === 1 ? true : undefined, 'second picker')
    const picker = h.sent.findLast(s => s.replyMarkup !== undefined)
    expect(picker?.replyMarkup?.inline_keyboard).toEqual([
      [{ text: '✓ obsidian', callback_data: 'ws:ws-obsidian' }],
      [{ text: 'telegram', callback_data: 'ws:ws-telegram' }],
    ])
  })

  it('re-lists when the picked workspace is gone', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([callbackUpdate({ data: 'ws:missing' })])
    await waitFor(() => h.sent.some(s => s.text === 'That workspace is no longer available.') ? true : undefined, 'gone notice')
    expect(h.agents.length).toBe(0)
    expect(h.sent.some(s => s.replyMarkup !== undefined)).toBe(true)
  })

  it('denies unauthorized callback queries without creating a session', async () => {
    const h = createHarness({ allowAllUsers: false, allowedUserIds: [1] })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([callbackUpdate({ fromId: 42 })])
    await waitFor(() => h.answers.some(a => a.text === 'Access denied.') ? true : undefined, 'denied toast')
    expect(h.agents.length).toBe(0)
    expect(h.edits.length).toBe(0)
  })

  it('/skills without a binding prompts to choose a workspace', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/skills' })])
    await waitFor(() => h.sent.some(s => s.text === 'Choose a workspace first with /start.') ? true : undefined, 'prompt sent')
    expect(h.agents.length).toBe(0)
  })

  it('/skills lists user-invocable skill names that copy //name', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/skills@swxs_bot', updateId: 2 })])
    await waitFor(() => h.sent.some(s => s.text === 'Choose a skill.') ? true : undefined, 'skill picker')
    const picker = h.sent.findLast(s => s.text === 'Choose a skill.')
    expect(picker?.replyMarkup?.inline_keyboard).toEqual([
      [
        { text: 'tdd', copy_text: { text: '//tdd ' } },
        { text: 'code-review', copy_text: { text: '//code-review ' } },
      ],
    ])
    const skills = h.ctx.get('skills') as { list: ReturnType<typeof vi.fn> }
    expect(skills.list).toHaveBeenCalledWith({
      cwd: 'D:\\codehouse\\obsidian',
      scope: h.agents[0]?.agent,
    })
  })

  it('/skills reports when no skills are available', async () => {
    const h = createHarness({}, { skills: 'empty' })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/skills', updateId: 2 })])
    await waitFor(() => h.sent.some(s => s.text === 'No skills are available in this workspace.') ? true : undefined, 'empty notice')
  })

  it('/skills paginates 21 names two-across and edits on Next', async () => {
    const h = createHarness({}, { skills: 'many' })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/skills', updateId: 2 })])
    await waitFor(() => h.sent.some(s => s.text === 'Choose a skill.') ? true : undefined, 'skill picker')
    const first = h.sent.findLast(s => s.text === 'Choose a skill.')
    const firstRows = first?.replyMarkup?.inline_keyboard ?? []
    expect(firstRows).toHaveLength(11)
    expect(firstRows[0]).toEqual([
      { text: 'skill-00', copy_text: { text: '//skill-00 ' } },
      { text: 'skill-01', copy_text: { text: '//skill-01 ' } },
    ])
    expect(firstRows[9]).toEqual([
      { text: 'skill-18', copy_text: { text: '//skill-18 ' } },
      { text: 'skill-19', copy_text: { text: '//skill-19 ' } },
    ])
    expect(firstRows[10]).toEqual([{ text: 'Next ›', callback_data: 'sk:1' }])
    const editsBefore = h.edits.length
    h.client.getUpdates.mockResolvedValueOnce([callbackUpdate({
      updateId: 3,
      data: 'sk:1',
      callbackId: 'cb-page',
      text: 'Choose a skill.',
    })])
    await waitFor(() => h.edits.length > editsBefore ? true : undefined, 'page edited')
    const second = h.edits[h.edits.length - 1]
    expect(second?.replyMarkup?.inline_keyboard).toEqual([
      [{ text: 'skill-20', copy_text: { text: '//skill-20 ' } }],
      [{ text: '‹ Prev', callback_data: 'sk:0' }],
    ])
  })

  it('/skills reports when the skills service is absent', async () => {
    const h = createHarness({}, { skills: 'missing' })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    await bindDefaultWorkspace(h)
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/skills', updateId: 2 })])
    await waitFor(() => h.sent.some(s => s.text === 'No skills are available in this workspace.') ? true : undefined, 'missing notice')
  })
})
