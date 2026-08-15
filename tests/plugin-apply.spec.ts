import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as agentCore from '@deepseek-ai/dsh-agent-spine-demo'
import * as telegram from '../src/index.ts'
import { apply } from '../src/index.ts'
import type { TelegramClientLike } from '../src/client.ts'

/**
 * Mount the real namespace plugin on a real Context with the agent spine,
 * using a fake client seam. Covers the full mount/poll/dispose lifecycle and
 * the fail-loud missing-token path; message flow is covered by the bridge
 * unit tests because a turn needs a live LLM adapter.
 */

async function waitFor<T>(get: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 5000
  for (;;) {
    const value = get()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function fakeClient(): TelegramClientLike & { polls: number } {
  const client = {
    polls: 0,
    async getMe() {
      return { id: 1, is_bot: true }
    },
    async getUpdates() {
      client.polls += 1
      return []
    },
    async sendMessage() {
      return { message_id: 1, chat: { id: 7, type: 'private' }, date: 0 }
    },
    async sendChatAction() {
      return true
    },
  }
  return client
}

function fakePresets(): {
  resolve(id?: string): Promise<{ id: string }>
  mount(): Promise<void>
} {
  return {
    async resolve(id?: string) {
      return { id: id ?? 'standard' }
    },
    async mount() {},
  }
}

function provideAgentPresets(ctx: Context): void {
  const service = fakePresets()
  const record = ctx as Context & {
    provide?(name: string, value: unknown): void
    set?(name: string, value: unknown): void
  }
  if (typeof record.provide === 'function') {
    record.provide('agentPresets', service)
    return
  }
  if (typeof record.set === 'function') {
    record.set('agentPresets', service)
    return
  }
  Object.assign(ctx, { agentPresets: service })
}

describe('dsh-telegram plugin apply', () => {
  it('mounts on the agent spine, polls through the client seam, and disposes cleanly', async () => {
    const client = fakeClient()
    const ctx = new Context()
    await ctx.plugin(agentCore, { workspaceContext: false })
    provideAgentPresets(ctx)
    await ctx.plugin(telegram, { token: 'test-token', client, sleep: async (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) })
    await waitFor(() => client.polls > 0 ? true : undefined, 'first poll')
    const pollsAtMount = client.polls
    await ctx.fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(client.polls).toBe(pollsAtMount)
  })

  it('fails loudly at load when the token is missing', async () => {
    const ctx = new Context()
    await ctx.plugin(agentCore, { workspaceContext: false })
    provideAgentPresets(ctx)
    await expect(ctx.plugin(telegram, {})).rejects.toThrow('missing bot token')
  })

  it('falls back to the DSH_TELEGRAM_TOKEN environment variable', async () => {
    const previous = process.env.DSH_TELEGRAM_TOKEN
    process.env.DSH_TELEGRAM_TOKEN = 'env-token'
    try {
      const client = fakeClient()
      const ctx = new Context()
      await ctx.plugin(agentCore, { workspaceContext: false })
      provideAgentPresets(ctx)
      await ctx.plugin(telegram, { client, sleep: async (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) })
      await waitFor(() => client.polls > 0 ? true : undefined, 'first poll')
      await ctx.fiber.dispose()
    } finally {
      if (previous === undefined) {
        delete process.env.DSH_TELEGRAM_TOKEN
      } else {
        process.env.DSH_TELEGRAM_TOKEN = previous
      }
    }
  })

  it('rejects an empty token from the environment', async () => {
    const previous = process.env.DSH_TELEGRAM_TOKEN
    process.env.DSH_TELEGRAM_TOKEN = ''
    try {
      const ctx = new Context()
      await ctx.plugin(agentCore, { workspaceContext: false })
      provideAgentPresets(ctx)
      await expect(ctx.plugin(telegram, {})).rejects.toThrow('missing bot token')
    } finally {
      if (previous === undefined) {
        delete process.env.DSH_TELEGRAM_TOKEN
      } else {
        process.env.DSH_TELEGRAM_TOKEN = previous
      }
    }
  })

  it('fails loudly at load when agentPresets is missing', () => {
    const ctx = {
      get: () => undefined,
      effect: () => {},
    }
    expect(() => apply(ctx as unknown as Context, { token: 'test-token' })).toThrow('missing agentPresets')
  })
})
