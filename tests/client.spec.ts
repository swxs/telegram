import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { TelegramClient } from '../src/client.ts'

/** Mock with a fetch-shaped call signature: keeps mock.calls typed and the value assignable. */
type FetchSeam = Mock<(url: string | URL, init?: RequestInit) => Promise<Response>>

/** Build a fetch seam mock; plain vi.fn inference would narrow calls to an empty tuple. */
function fetchMock(impl: () => Promise<Response>): FetchSeam {
  return vi.fn(impl)
}

/** Build a fake Response with the given JSON payload and status. */
function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

describe('TelegramClient', () => {
  it('rejects an empty token', () => {
    expect(() => new TelegramClient('')).toThrow('token must not be empty')
  })

  it('defaults the API base URL and polling timeout', () => {
    const client = new TelegramClient('t:ok')
    expect(client.pollingTimeoutSec).toBe(30)
  })

  it('getMe returns the bot user', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: { id: 1, is_bot: true } }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await expect(client.getMe()).resolves.toEqual({ id: 1, is_bot: true })
    const url = fetchImpl.mock.calls[0]?.[0] as string
    expect(url).toBe('https://api.telegram.org/bott:ok/getMe')
  })

  it('getUpdates passes the acknowledged offset and polling timeout', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: [] }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch, pollingTimeoutSec: 15 })
    await client.getUpdates(42)
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body).toMatchObject({ offset: 42, timeout: 15, allowed_updates: ['message'] })
  })

  it('getUpdates omits offset when starting fresh', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: [] }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await client.getUpdates()
    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body.offset).toBeUndefined()
  })

  it('sendMessage forwards parse mode only when requested', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: { message_id: 1, chat: { id: 7, type: 'private' }, date: 0 } }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await client.sendMessage(7, 'hi')
    let body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body).toEqual({ chat_id: 7, text: 'hi' })
    await client.sendMessage(7, '<b>hi</b>', 'HTML')
    body = JSON.parse((fetchImpl.mock.calls[1]?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body).toMatchObject({ parse_mode: 'HTML' })
  })

  it('sendChatAction posts the action', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: true }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await expect(client.sendChatAction(7, 'typing')).resolves.toBe(true)
  })

  it('redacts thrown non-Error values from transport errors', async () => {
    const fetchImpl = fetchMock(async () => { throw 'raw failure with bott:ok' })
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await expect(client.getMe()).rejects.toThrow('telegram getMe transport error: raw failure with bot***')
  })

  it('throws a redacted error on transport failure', async () => {
    const fetchImpl = fetchMock(async () => { throw new Error('connect failed to bott:ok') })
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await expect(client.getMe()).rejects.toThrow('telegram getMe transport error: connect failed to bot***')
  })

  it('throws a redacted error on a non-ok response', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse(
      { ok: false, description: 'Unauthorized for bott:ok' },
      401,
    ))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await expect(client.getMe()).rejects.toThrow('telegram getMe failed: Unauthorized for bot***')
  })

  it('throws with the HTTP status when the response is not JSON', async () => {
    const fetchImpl = fetchMock(async () => new Response('<html>bad gateway</html>', { status: 502 }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch })
    await expect(client.getMe()).rejects.toThrow('telegram getMe failed: HTTP 502')
  })

  it('honors a custom base URL', async () => {
    const fetchImpl = fetchMock(async () => jsonResponse({ ok: true, result: { id: 1, is_bot: true } }))
    const client = new TelegramClient('t:ok', { fetch: fetchImpl as typeof fetch, baseUrl: 'http://localhost:8080' })
    await client.getMe()
    expect((fetchImpl.mock.calls[0]?.[0] as string).startsWith('http://localhost:8080/bott:ok/getMe')).toBe(true)
  })
})
