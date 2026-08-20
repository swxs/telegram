/**
 * telegram probe: boot the real dsh composition (base + personal overlay)
 * without any API key and assert the externally mounted telegram plugin's
 * entry activates. The plugin is a background service and contributes no
 * model-facing tools, so activation is the whole assertion.
 *
 * `apply` fails loudly without a bot token (config.token or
 * DSH_TELEGRAM_TOKEN), so the probe sets a dummy token to let the plugin
 * mount; the long-poll loop then logs redacted 401 warnings and backs off
 * while the probe runs — those are runtime polling errors, not load failures.
 *
 * Run from the dsh checkout so tsx picks up its tsconfig paths:
 *   cd <dsh-checkout> && node --import tsx/esm /root/plugin-repos/dsh-telegram/probe.mjs
 */

import { existsSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { boot, loadPersonalPatches } from '@deepseek-ai/dsh-app-boot'

// apply() throws when no token is set — a dummy value lets the plugin mount;
// the resulting Telegram 401s are logged warnings with the token redacted.
process.env.DSH_TELEGRAM_TOKEN = process.env.DSH_TELEGRAM_TOKEN ?? 'probe-dummy-token'

/** Locate the dsh checkout from the `dsh` launcher on PATH. */
function resolveCheckout() {
  const pathDirs = (process.env.PATH ?? '').split(/[:;]/)
  for (const dir of pathDirs) {
    const launcher = resolve(dir, 'dsh')
    if (!existsSync(launcher)) continue
    const real = realpathSync(launcher)
    const candidate = resolve(real, '..', '..')
    if (existsSync(resolve(candidate, 'packages'))) return candidate
  }
  throw new Error('probe: cannot locate the dsh checkout (put dsh on PATH)')
}

const checkout = process.env.DSH_CHECKOUT ?? resolveCheckout()
const configPath = resolve(checkout, 'apps/cli/config/base.cordis.yml')
const patches = loadPersonalPatches('telegram-probe') ?? []
console.log(`probe: booting ${configPath} with ${patches.length} personal patch(es)`)

const ctx = await boot('telegram-probe', configPath, patches, (ctx) => {
  // base.cordis.yml evaluates `!!js launcherSessionQueryPath ?? ...` against
  // the entry context; the real launchers provide this key (tui.ts).
  ctx.provide('launcherSessionQueryPath', '/root/.dsh/sessions/query-probe.db')
})

const telegramEntries = [...ctx.loader.entries()].filter(entry =>
  entry.options.name.includes('/.external-plugins/telegram/'))
for (const entry of telegramEntries) {
  console.log('telegram entry:', entry.options.name)
  console.log('telegram fiber:', entry.fiber !== undefined ? 'active' : 'missing')
}

// Capture activation before disposal: the loader clears entry.fiber during
// teardown, so checking after dispose would always report missing.
const activated = telegramEntries.length > 0
  && telegramEntries.every(entry => entry.fiber !== undefined)
await ctx.fiber.dispose()
process.exit(activated ? 0 : 1)
