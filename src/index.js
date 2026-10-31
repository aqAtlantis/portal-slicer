// Portal slicer bot:
//   login (offline + EasyAuth, same as the cleric bot) and auto-reconnect,
//   totem in offhand, totem-pop report + log off, auto-eat when sprint is lost,
//   inventory check + hub restock before every portal, chat/terminal commands,
//   persistent progress file, and the slicing loop (9 portals x 20 units x 50 rows).
const mineflayer = require('mineflayer')
const path = require('path')
const readline = require('readline')
const { loadConfig, validateForLogin, ROOT } = require('./config')
const log = require('./logger')
const state = require('./state')
const inv = require('./inventory')
const plan = require('./plan')
const movement = require('./movement')
const { restock } = require('./hub')
const survival = require('./survival')
const { setupCommands } = require('./commands')
const { ServerAuth, componentText } = require('./server-auth')
const { Lock } = require('./lock')
const slicer = require('./slicer')
const { efficiencyLevel } = require('./dig')

const cfg = loadConfig()

if (process.argv.includes('--clear-lockout')) {
  state.clearLockout()
  state.save({ status: 'idle' })
  console.log('Lockout cleared. Start the bot with: npm start')
  process.exit(0)
}

let reconnectDelay = cfg.reconnect.delayMs
let stopForGood = false
let current = null // { bot, ctx, serverAuth, commands } for the terminal

function start () {
  const lock = state.lockoutReason()
  if (lock) {
    log.error(`Refusing to log in — lockout is active: ${lock}`)
    log.error('Read the report in logs/, then run: npm run clear-lockout')
    process.exit(1)
  }
  const problems = validateForLogin(cfg)
  if (problems.length) {
    log.error('config.json: ' + problems.join('; '))
    process.exit(1)
  }

  const s = state.load()
  const p = plan.portalAt(cfg, Math.min(s.portalIndex, plan.total(cfg) - 1))
  log.info(`Resuming at portal #${s.portalIndex + 1} (row ${p.row + 1}, unit ${p.unit + 1}, portal ${p.portal + 1}), step "${s.step}"`)
  log.info(`Connecting to ${cfg.connection.host}:${cfg.connection.port} as ${cfg.connection.username}`)

  const bot = mineflayer.createBot({
    ...cfg.connection,
    profilesFolder: path.join(ROOT, '.auth-cache'),
    hideErrors: false
  })

  const ctx = {
    lock: new Lock(),
    authenticated: false,
    paused: false,
    forceRestock: false,
    stopRequested: false,
    shuttingDown: false,
    totemPopped: false,
    damageHistory: [],
    wake: null
  }
  const cleanups = []
  let spawned = false
  let jobStarted = false

  const serverAuth = new ServerAuth(bot, cfg.serverAuth, {
    log: m => log.info(`[Auth] ${m}`),
    onChange: ok => {
      ctx.authenticated = ok
      if (ok) maybeStartJob()
    }
  })
  ctx.authenticated = serverAuth.authenticated
  const commands = setupCommands(bot, cfg, ctx)
  current = { bot, ctx, serverAuth, commands }

  survival.setupDamageTracking(bot, ctx)

  async function maybeStartJob () {
    if (!spawned || !ctx.authenticated || jobStarted || ctx.shuttingDown) return
    jobStarted = true
    try {
      await bot.waitForChunksToLoad()
      await movement.sleep(1500) // let inventory arrive
      log.info(`Ready as ${bot.username} at ${bot.entity.position.floored()} in ${bot.game.dimension}`)
      await survival.equipTotem(bot)
      await runJob(bot, ctx)
    } catch (e) {
      log.error('job loop crashed:', e.stack || e.message)
    }
  }

  bot.once('spawn', () => {
    spawned = true
    reconnectDelay = cfg.reconnect.delayMs
    movement.setup(bot)
    survival.setupTotemWatch(bot, ctx)
    cleanups.push(survival.startAutoEat(bot, cfg, ctx))
    serverAuth.onSpawn()
    maybeStartJob()
  })

  bot.on('message', (message, position, sender) => {
    log.info(`[Server/${position ?? '?'}] ${serverAuth.redact(componentText(message))}`)
    serverAuth.handleMessage(message, { position, sender })
  })
  bot.on('kicked', reason => log.warn('kicked:', serverAuth.redact(componentText(reason) || String(reason))))
  bot.on('error', err => log.error('connection error:', err.message))

  bot.on('end', reason => {
    ctx.shuttingDown = true
    ctx.wake?.()
    cleanups.forEach(fn => fn())
    const st = state.get()
    // state.json is saved after every change; this just records the disconnect.
    log.writeReport('last_disconnect.txt',
      `${new Date().toISOString()}\nreason: ${reason}\nportal #${st.portalIndex + 1} step "${st.step}" status "${st.status}"\n`)
    log.warn(`Disconnected (${reason}). Progress saved: portal #${st.portalIndex + 1}, step "${st.step}"`)

    if (ctx.totemPopped || state.lockoutReason()) { log.error('Not reconnecting (lockout).'); process.exit(2) }
    if (ctx.stopRequested || stopForGood || !cfg.reconnect.enabled) process.exit(0)
    if (cfg.serverAuth?.enabled && !process.env[cfg.serverAuth.passwordEnv]) {
      log.warn(`No ${cfg.serverAuth.passwordEnv} set, so after reconnecting you must type /login PASSWORD in this terminal.`)
    }
    log.info(`Reconnecting in ${Math.round(reconnectDelay / 1000)}s`)
    setTimeout(start, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, cfg.reconnect.maxDelayMs)
  })
}

// Phase 1 job: make sure the bot is supplied. Phase 3 puts the slicing loop
// here, calling maintenance() before every portal.
async function maintenance (bot, ctx) {
  const c = inv.check(bot, cfg)
  if (!c.needed && !ctx.forceRestock) return true
  log.info(`Restock needed: ${ctx.forceRestock ? 'owner request' : c.reasons.join(', ')}`)
  ctx.forceRestock = false
  const r = await restock(bot, cfg, ctx)
  if (!r.ok) {
    ctx.paused = true
    state.save({ running: false })
    ctx.notify?.(`Restock incomplete (${r.missing.join(', ')}) — paused. Fix the hub and say "${cfg.chatPrefix} start".`)
    return false
  }
  await survival.equipTotem(bot)
  return true
}

function notify (bot, text) {
  log.info(`[notify] ${text}`)
  for (const owner of cfg.owners) {
    if (bot.players?.[owner]) { try { bot.whisper(owner, `[Slicer] ${text}`.slice(0, 250)) } catch (_) {} }
  }
}

async function runJob (bot, ctx) {
  ctx.notify = text => notify(bot, text)
  log.info('Inventory: ' + inv.summary(bot))
  const pick = inv.bestPickaxe(bot)
  if (pick) {
    const eff = efficiencyLevel(bot, pick.item, cfg.slicing.efficiencyOverride)
    log.info(`Pickaxe: Efficiency ${eff}, ${pick.remaining} durability. Obsidian will take ~${(digTicksFor(bot, eff) / 20).toFixed(2)} s each.`)
  }
  if (!state.get().running) log.info(`Waiting for "${cfg.chatPrefix} start" (all portals) or "${cfg.chatPrefix} once" (one portal).`)

  let failures = 0
  while (!ctx.shuttingDown && !ctx.stopRequested) {
    if (ctx.paused || !state.get().running) { await waitForWake(ctx, 5000); continue }

    const index = state.get().portalIndex
    if (index >= plan.total(cfg)) {
      state.save({ running: false, status: 'finished' })
      ctx.notify(`All ${plan.total(cfg)} portals finished!`)
      continue
    }

    // Before each portal: restock if anything is low.
    await maintenance(bot, ctx)
    if (ctx.paused || ctx.shuttingDown) continue

    try {
      const r = await slicer.runPortal(bot, cfg, ctx, index)
      const s = state.get()
      const patch = { portalIndex: index + 1, step: state.STEPS[0], status: 'slicing' }
      if (!r.skipped) patch.completedPortals = s.completedPortals + 1
      if (!r.ok) {
        patch.failedPortals = [...s.failedPortals, index + 1]
        failures++
        ctx.notify(`Portal #${index + 1} broke completely (no portal left after slicing).`)
      } else {
        failures = 0
        log.info(`Portal #${index + 1} done. Portal left at: ${r.remnant.map(String).join(' ')}`)
      }
      state.save(patch)
      if (failures >= cfg.slicing.maxConsecutiveFailures) {
        ctx.paused = true
        state.save({ running: false, status: 'paused' })
        ctx.notify(`${failures} portals in a row broke — paused. Check them, then "${cfg.chatPrefix} start".`)
      }
    } catch (e) {
      if (ctx.shuttingDown) break
      if (e.pausedByOwner) { log.info(`Paused: ${e.message}`); continue }
      log.error(e.stack || e.message)
      ctx.paused = true
      state.save({ running: false, status: 'paused' })
      ctx.notify(`Paused: ${e.message}`)
      continue
    }

    if (ctx.onceMode) {
      ctx.onceMode = false
      state.save({ running: false, status: 'idle' })
      ctx.notify(`One portal done (next is #${state.get().portalIndex + 1}). Say "${cfg.chatPrefix} start" to continue.`)
    }
  }
}

// Obsidian dig time for the startup log line.
function digTicksFor (bot, eff) {
  const speed = 9 + (eff > 0 ? eff * eff + 1 : 0)
  return Math.ceil(1 / (speed / 50 / 30))
}

function waitForWake (ctx, ms) {
  return new Promise(resolve => {
    const t = setTimeout(done, ms)
    function done () { clearTimeout(t); ctx.wake = null; resolve() }
    ctx.wake = done
  })
}

// Terminal, same as the cleric bot: "/login PASSWORD", "/l PASSWORD",
// "say MESSAGE", "/anycommand", or a bot command like "status".
const input = readline.createInterface({ input: process.stdin, output: process.stdout })
input.on('line', line => {
  const text = line.trim()
  if (!text || !current) return
  const { bot, ctx, serverAuth, commands } = current
  try {
    const outbound = /^say\s+/i.test(text) ? text.replace(/^say\s+/i, '') : text.startsWith('/') ? text : null
    if (outbound === null) return commands.terminal(text)
    if (/^\/(?:login|l|register|reg)(?:\s|$)/i.test(outbound)) return serverAuth.sendRaw(outbound)
    if (!ctx.authenticated) throw new Error('Send /login first.')
    bot.chat(outbound)
  } catch (e) { console.error(serverAuth.redact(e.message)) }
})

process.on('SIGINT', () => {
  stopForGood = true
  log.info('Ctrl+C — saving and exiting')
  state.save({})
  if (current) current.bot.quit('Stopped from terminal')
  setTimeout(() => process.exit(0), 500)
})

start()
