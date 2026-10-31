// Eating, totem in offhand, and the "totem popped -> write report + log off" rule.
const log = require('./logger')
const state = require('./state')
const inv = require('./inventory')

const TOTEM_POP_STATUS = 35 // entity_status code the server sends when a totem is used

function setupDamageTracking (bot, ctx) {
  ctx.damageHistory = []
  let lastHealth = null
  bot.on('health', () => {
    if (lastHealth !== null && bot.health < lastHealth) {
      ctx.damageHistory.push({
        time: new Date().toISOString(),
        from: lastHealth,
        to: bot.health,
        food: bot.food,
        pos: bot.entity ? bot.entity.position.toString() : null
      })
      if (ctx.damageHistory.length > 40) ctx.damageHistory.shift()
    }
    lastHealth = bot.health
  })
  bot.on('entityHurt', (entity, source) => {
    if (!bot.entity || entity !== bot.entity) return
    const last = ctx.damageHistory[ctx.damageHistory.length - 1]
    const who = source ? (source.username || source.name || source.type) : 'unknown/environment'
    if (last && !last.source) last.source = who
    else ctx.damageHistory.push({ time: new Date().toISOString(), source: who })
  })
}

async function equipTotem (bot) {
  const off = bot.inventory.slots[45]
  if (off && off.name === 'totem_of_undying') return true
  const totem = bot.inventory.items().find(i => i.name === 'totem_of_undying')
  if (!totem) { log.warn('no totem of undying in inventory'); return false }
  await bot.equip(totem, 'off-hand')
  log.info('totem equipped in offhand')
  return true
}

function findFood (bot, cfg) {
  for (const name of cfg.food.items) {
    const it = bot.inventory.items().find(i => i.name === name)
    if (it) return it
  }
  return null
}

async function eatNow (bot, cfg) {
  const before = bot.heldItem
  let ate = 0
  while (bot.food < cfg.food.eatUntil) {
    const food = findFood(bot, cfg)
    if (!food) { log.warn('hungry but no golden carrots / porkchops left'); break }
    await bot.equip(food, 'hand')
    const f0 = bot.food
    await bot.consume()
    ate++
    if (bot.food <= f0) break // server didn't accept it, don't loop forever
  }
  if (before && bot.heldItem?.name !== before.name) {
    const back = bot.inventory.items().find(i => i.name === before.name)
    if (back) await bot.equip(back, 'hand').catch(() => {})
  }
  if (ate) log.info(`ate ${ate} item(s), food now ${bot.food}`)
}

// Food <= 6 means no sprinting. Checked twice a second; eating waits for the
// lock so it never interrupts a chest window or (in phase 3) a slicing step.
function startAutoEat (bot, cfg, ctx) {
  let eating = false
  const timer = setInterval(() => {
    if (eating || ctx.shuttingDown || !bot.entity) return
    if (bot.food > cfg.food.eatAtOrBelow) return
    eating = true
    ctx.lock.run(() => eatNow(bot, cfg))
      .catch(e => log.warn('eat failed:', e.message))
      .finally(() => { eating = false })
  }, 500)
  return () => clearInterval(timer)
}

function writeTotemReport (bot, ctx) {
  const s = state.get()
  const now = new Date()
  const nearby = Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.position && bot.entity && e.position.distanceTo(bot.entity.position) < 24)
    .map(e => `  - ${e.username || e.name || e.type} at ${e.position.floored()} (${e.position.distanceTo(bot.entity.position).toFixed(1)} m)`)
  const text = [
    '# TOTEM POPPED — bot logged off',
    '',
    `Time: ${now.toISOString()} (local ${now.toString()})`,
    `Position: ${bot.entity ? bot.entity.position.toString() : 'unknown'}`,
    `Dimension: ${bot.game ? bot.game.dimension : 'unknown'}`,
    `Health after pop: ${bot.health}   Food: ${bot.food}`,
    `Held item: ${bot.heldItem ? bot.heldItem.name : 'nothing'}`,
    `Inventory: ${inv.summary(bot)}`,
    `Job progress: portal #${s.portalIndex} step "${s.step}", ${s.completedPortals} portals done, status was "${s.status}"`,
    '',
    '## Damage leading up to the pop (oldest first)',
    ...(ctx.damageHistory || []).map(d => `  - ${d.time} ${d.from ?? '?'} -> ${d.to ?? '?'} hp` +
      `${d.source ? ' source: ' + d.source : ''}${d.pos ? ' at ' + d.pos : ''}`),
    '',
    '## Entities within 24 blocks',
    ...(nearby.length ? nearby : ['  (none)']),
    '',
    '## Last 60 log lines',
    ...log.recent(60),
    '',
    'The bot will NOT reconnect until you run:  npm run clear-lockout',
    ''
  ].join('\n')
  const name = `TOTEM_POP_${now.toISOString().replace(/[:.]/g, '-')}.md`
  return log.writeReport(name, text)
}

function setupTotemWatch (bot, ctx) {
  bot._client.on('entity_status', packet => {
    if (!bot.entity || packet.entityId !== bot.entity.id) return
    if (packet.entityStatus !== TOTEM_POP_STATUS) return
    if (ctx.shuttingDown) return
    ctx.shuttingDown = true
    ctx.totemPopped = true
    let file = '(report failed)'
    try { file = writeTotemReport(bot, ctx) } catch (e) { log.error('totem report failed', e.message) }
    state.save({ status: 'totem_lockout' })
    state.setLockout(`totem popped, see ${file}`)
    log.error(`TOTEM POPPED — report written to ${file}. Logging off.`)
    bot.pathfinder?.setGoal(null)
    bot.clearControlStates()
    bot.quit('totem popped')
  })

  bot.on('death', () => {
    ctx.shuttingDown = true
    try { writeTotemReport(bot, ctx) } catch (_) {}
    state.save({ status: 'totem_lockout' })
    state.setLockout('bot DIED')
    log.error('BOT DIED. Logging off.')
    bot.quit('died')
  })
}

module.exports = { setupDamageTracking, equipTotem, startAutoEat, eatNow, setupTotemWatch }
