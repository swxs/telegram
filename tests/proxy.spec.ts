import { describe, expect, it } from 'vitest'
import { formatProxyForLog, createProxiedFetch, resolveTelegramProxy } from '../src/proxy.ts'

describe('resolveTelegramProxy', () => {
  it('uses a non-empty config value over env', () => {
    expect(resolveTelegramProxy('http://localhost:15236', {
      HTTPS_PROXY: 'http://env-https:1',
      HTTP_PROXY: 'http://env-http:1',
    })).toBe('http://localhost:15236')
  })

  it('trims config whitespace', () => {
    expect(resolveTelegramProxy('  http://localhost:15236  ', {})).toBe('http://localhost:15236')
  })

  it('treats empty and whitespace config as unset', () => {
    expect(resolveTelegramProxy('', {})).toBeUndefined()
    expect(resolveTelegramProxy('   ', {})).toBeUndefined()
    expect(resolveTelegramProxy(undefined, {})).toBeUndefined()
  })

  it('prefers HTTPS_PROXY then HTTP_PROXY when config is empty', () => {
    expect(resolveTelegramProxy('', {
      HTTPS_PROXY: 'http://https-proxy:1',
      HTTP_PROXY: 'http://http-proxy:1',
    })).toBe('http://https-proxy:1')
    expect(resolveTelegramProxy('', {
      HTTP_PROXY: 'http://http-proxy:1',
    })).toBe('http://http-proxy:1')
    expect(resolveTelegramProxy('', {
      https_proxy: 'http://lower-https:1',
      HTTP_PROXY: 'http://http-proxy:1',
    })).toBe('http://lower-https:1')
  })

  it('rejects a non-http(s) scheme', () => {
    expect(() => resolveTelegramProxy('socks5://127.0.0.1:1080', {})).toThrow('need http:// or https://')
    expect(() => resolveTelegramProxy('', { HTTP_PROXY: 'socks5://127.0.0.1:1080' })).toThrow('from HTTP_PROXY')
  })

  it('rejects a malformed URL', () => {
    expect(() => resolveTelegramProxy('not a url', {})).toThrow('invalid proxy URL from config')
  })
})

describe('formatProxyForLog', () => {
  it('keeps host and port and redacts userinfo', () => {
    expect(formatProxyForLog('http://localhost:15236')).toBe('http://localhost:15236')
    expect(formatProxyForLog('http://user:secret@127.0.0.1:7890')).toBe('http://***@127.0.0.1:7890')
  })
})

describe('createProxiedFetch', () => {
  it('returns a fetch wrapper that can be closed without a live proxy', async () => {
    const proxied = createProxiedFetch('http://127.0.0.1:9')
    expect(typeof proxied.fetch).toBe('function')
    await expect(proxied.close()).resolves.toBeUndefined()
  })
})
