import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { TelegramBridge } from '../src/bridge.ts'
import type { TelegramBridgeOptions } from '../src/bridge.ts'
import type { BotCommand, TelegramClientLike, TelegramUpdate } from '../src/client.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

interface FakeAgent {
  session: { id: string }
  followup: ReturnType<typeof vi.fn>
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
  sent: { chatId: number; text: string; parseMode?: 'HTML' }[]
  actions: { chatId: number; action: string }[]
  polls: (number | undefined)[]
  sleeps: number[]
  emit(sessionId: string, event: SessionEvent): void
}

interface HarnessSeams {
  /** Default: a fake that resolves `preset ?? 'standard'`. `missing` omits the service. */
  agentPresets?: 'default' | 'missing'
  /** Default: a fake workspace. `missing` omits it; `throwing` rejects attach. */
  workspaceRegistry?: 'default' | 'missing' | 'throwing'
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
  const workspace = { attachSession }
  const registry = {
    resolveByPath: vi.fn(async () => workspace),
    create: vi.fn(async () => workspace),
  }
  if (seams.workspaceRegistry === 'throwing') {
    attachSession.mockRejectedValue(new Error('attach failed'))
  }
  let listener: ((session: { id: string }, event: SessionEvent) => void) | undefined
  let menu: BotCommand[] = []
  const client: TelegramClientLike & {
    getMe: Mock
    getUpdates: Mock
    sendMessage: Mock
    sendChatAction: Mock
    setMyCommands: Mock
    getMyCommands: Mock
  } = {
    getMe: vi.fn(async () => ({ id: 1, is_bot: true })),
    getUpdates: vi.fn(async (offset?: number) => { polls.push(offset); return [] as TelegramUpdate[] }),
    sendMessage: vi.fn(async (chatId: number, text: string, parseMode?: 'HTML') => {
      sent.push(parseMode === undefined ? { chatId, text } : { chatId, text, parseMode })
      return { message_id: 1, chat: { id: chatId, type: 'private' }, date: 0 }
    }),
    sendChatAction: vi.fn(async (chatId: number, action: string) => {
      actions.push({ chatId, action })
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
    sent,
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

function update(message: Partial<{ chatId: number; fromId: number; text: string }> = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: message.chatId ?? 7, type: 'private' },
      from: { id: message.fromId ?? 42 },
      ...(message.text === undefined ? {} : { text: message.text }),
      date: 0,
    },
  }
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
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'hello' })])
    await waitFor(() => h.agents[0], 'agent created')
    expect(h.agents[0]?.agent.followup).toHaveBeenCalledTimes(1)
    const message = h.agents[0]?.agent.followup.mock.calls[0]?.[0] as { content: { text: string }[] }
    expect(message.content[0]?.text).toBe('hello')
  })

  it('advances the polling offset and reuses the chat agent', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([
      update({ text: 'one' }),
      { update_id: 2, message: { message_id: 2, chat: { id: 7, type: 'private' }, from: { id: 42 }, text: 'two', date: 0 } },
    ])
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'agent created')
    await settle()
    expect(h.agents[0]?.agent.followup).toHaveBeenCalledTimes(2)
    await waitFor(() => h.polls.some(offset => offset === 3) ? true : undefined, 'offset advanced')
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
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'hi', fromId: 99 })])
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
    // no-text updates are ignored, the text update creates the chat agent.
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'text update processed')
    await settle()
    expect(h.sent.length).toBe(0)
  })

  it('/start creates a session and sends the welcome', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/start' })])
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'agent created')
    await waitFor(() => h.sent.some(s => s.text.includes('Hello')) ? true : undefined, 'welcome sent')
  })

  it('/clear rotates the session agent and disposes the previous one', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'first' })])
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'first agent')
    const first = h.agents[0]!
    h.client.getUpdates.mockResolvedValueOnce([{ ...update({ text: '/clear' }), update_id: 2 }])
    await waitFor(() => h.agents.length === 2 ? true : undefined, 'second agent')
    expect(first.dispose).toHaveBeenCalledTimes(1)
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
      { command: 'start', description: 'start a session' },
      { command: 'clear', description: 'reset the current session' },
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

  it('replies to unknown commands', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: '/bogus' })])
    await waitFor(() => h.sent.some(s => s.text.includes('Unknown command')) ? true : undefined, 'unknown reply')
  })

  it('delivers assistant text as split HTML messages', async () => {
    const h = createHarness({ maxMessageLength: 12 })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'go' })])
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'agent created')
    const long = 'a'.repeat(30)
    h.emit(h.agents[0]!.agent.session.id, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: long }] } },
    } as SessionEvent)
    await waitFor(() => h.sent.length >= 3 ? true : undefined, 'chunks delivered')
    expect(h.sent.map(s => s.text).join('')).toBe(long)
    expect(h.sent.every(s => s.parseMode === 'HTML')).toBe(true)
  })

  it('ignores assistant messages without text blocks', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'go' })])
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'agent created')
    h.emit(h.agents[0]!.agent.session.id, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'tool', id: 't' }] } },
    } as SessionEvent)
    await settle()
    expect(h.sent.length).toBe(0)
  })

  it('falls back to plain text when HTML delivery is rejected', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'go' })])
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'agent created')
    h.client.sendMessage
      .mockRejectedValueOnce(new Error('can\'t parse entities'))
      .mockResolvedValue({ message_id: 1, chat: { id: 7, type: 'private' }, date: 0 })
    h.emit(h.agents[0]!.agent.session.id, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '<b>hi</b>' }] } },
    } as SessionEvent)
    await waitFor(() => h.client.sendMessage.mock.calls.length >= 2 ? true : undefined, 'fallback sent')
    const first = h.client.sendMessage.mock.calls[0] as [number, string, 'HTML' | undefined]
    const second = h.client.sendMessage.mock.calls[1] as [number, string, 'HTML' | undefined]
    expect(first).toEqual([7, '&lt;b&gt;hi&lt;/b&gt;', 'HTML'])
    expect(second).toEqual([7, '<b>hi</b>'])
  })

  it('logs a delivery failure when the plain-text fallback also fails', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'go' })])
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'agent created')
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
    h.client.sendChatAction.mockRejectedValue(new Error('action down'))
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'go' })])
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'agent created')
    h.emit(h.agents[0]!.agent.session.id, { type: 'turn/start', data: {} } as SessionEvent)
    await waitFor(() => h.ctx.logger.warn.mock.calls.length > 0 ? true : undefined, 'action warning logged')
    expect(h.ctx.logger.warn.mock.calls[0]?.[0]).toBe('[telegram] chat action %s failed: %s')
  })

  it('sends the typing action on turn start', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'go' })])
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'agent created')
    h.emit(h.agents[0]!.agent.session.id, { type: 'turn/start', data: {} } as SessionEvent)
    await waitFor(() => h.actions.length === 1 ? true : undefined, 'typing sent')
    expect(h.actions[0]).toEqual({ chatId: 7, action: 'typing' })
  })

  it('ignores non-delivery event kinds on known sessions', async () => {
    const h = createHarness()
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'go' })])
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'agent created')
    h.emit(h.agents[0]!.agent.session.id, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent)
    await settle()
    expect(h.sent.length).toBe(0)
    expect(h.actions.length).toBe(0)
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
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'go' })])
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
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'go' })])
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'agent created')
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
      update({ text: 'hi' }),
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

  it('mounts the resolved preset and attaches the session on first chat', async () => {
    const h = createHarness({ preset: 'coding', cwd: 'D:\\codehouse\\obsidian' })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'hello' })])
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'agent created')
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
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'first' })])
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'first agent')
    h.client.getUpdates.mockResolvedValueOnce([{ ...update({ text: '/clear' }), update_id: 2 }])
    await waitFor(() => h.agents.length === 2 ? true : undefined, 'second agent')
    expect(h.creates).toHaveLength(2)
    expect(h.creates[1]?.meta?.agentPreset).toBe('standard')
    expect(h.creates[1]?.setup).toBeTypeOf('function')
    await waitFor(() => h.attachSession.mock.calls.length === 2 ? true : undefined, 'both sessions attached')
  })

  it('still delivers when workspace attach fails', async () => {
    const h = createHarness({}, { workspaceRegistry: 'throwing' })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'hello' })])
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'agent created')
    await waitFor(() => h.ctx.logger.warn.mock.calls.some((call: unknown[]) => String(call[0]).includes('workspace attach failed')) ? true : undefined, 'attach warning')
    h.emit(h.agents[0]!.agent.session.id, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'pong' }] } },
    } as SessionEvent)
    await waitFor(() => h.sent.some(s => s.text === 'pong') ? true : undefined, 'reply delivered')
  })

  it('skips workspace attach when the registry is absent', async () => {
    const h = createHarness({}, { workspaceRegistry: 'missing' })
    h.bridge.start()
    await waitFor(() => h.polls.length > 0 ? true : undefined, 'polling')
    h.client.getUpdates.mockResolvedValueOnce([update({ text: 'hello' })])
    await waitFor(() => h.agents.length === 1 ? true : undefined, 'agent created')
    await settle()
    expect(h.attachSession).not.toHaveBeenCalled()
    expect(h.creates[0]?.meta?.agentPreset).toBe('standard')
  })
})
