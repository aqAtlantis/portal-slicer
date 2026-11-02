// Safe pathfinding: never digs, never builds, never parkours, never steps into
// portals/fire, never treats a trapdoor as floor, and keeps drops to 2 blocks.
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const log = require('./logger')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function setup (bot) {
  if (!bot.pathfinder) bot.loadPlugin(pathfinder)
  const m = new Movements(bot)

  m.canDig = false // never break anything while walking (portals are fragile)
  m.allow1by1towers = false
  m.allowParkour = false
  m.allowSprinting = true
  m.canOpenDoors = false
  m.dontCreateFlow = true
  m.maxDropDown = 2
  m.scafoldingBlocks = []

  const avoid = ['nether_portal', 'fire', 'soul_fire', 'lava', 'magma_block']
  for (const name of avoid) {
    const b = bot.registry.blocksByName[name]
    if (b) m.blocksToAvoid.add(b.id)
  }

  // Trapdoors: open ones are holes, closed ones are thin. Treat every trapdoor
  // as "not floor and not walk-through" so the bot routes around them.
  const origGetBlock = m.getBlock.bind(m)
  m.getBlock = (pos, dx, dy, dz) => {
    const b = origGetBlock(pos, dx, dy, dz)
    if (b && b.name && (b.name.endsWith('_trapdoor') || b.name === 'nether_portal')) {
      b.physical = false
      b.safe = false
    }
    return b
  }

  bot.pathfinder.setMovements(m)
  bot.pathfinder.thinkTimeout = 10000
  return m
}

// Walk to a block position (feet position). range 0 = stand exactly in that block.
// Retries up to 3 times: a player or item briefly in the way, or chunks still
// updating, can make a single attempt fail ("Took to long to decide path to goal").
async function goto (bot, x, y, z, range = 0, timeoutMs = 300000, attempts = 3) {
  const goal = range > 0 ? new goals.GoalNear(x, y, z, range) : new goals.GoalBlock(x, y, z)
  for (let a = 1; ; a++) {
    let timer
    try {
      await Promise.race([
        bot.pathfinder.goto(goal),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('goto timeout')), timeoutMs) })
      ])
      return
    } catch (e) {
      if (a >= attempts) throw e
      log.warn(`path to ${x} ${y} ${z} failed (${e.message}), retrying ${a}/${attempts - 1}`)
      bot.pathfinder.setGoal(null)
      bot.clearControlStates()
      await sleep(2000)
    } finally {
      clearTimeout(timer)
      bot.pathfinder.setGoal(null)
    }
  }
}

// Fine-tune to an exact x/z (e.g. a precise configured position) while sneaking, so it cannot
// walk off an edge during the adjustment.
async function moveToExact (bot, x, y, z, tolerance = 0.08, maxTicks = 80) {
  // Short shuffles (e.g. 1 block to the next portal) don't need the pathfinder:
  // the sneaking walk below can't fall off anything.
  const p0 = bot.entity.position
  const short = Math.hypot(x - p0.x, z - p0.z) < 2 && Math.abs(Math.floor(y) - Math.floor(p0.y)) === 0
  if (!short) await goto(bot, Math.floor(x), Math.floor(y), Math.floor(z))
  bot.setControlState('sneak', true)
  try {
    for (let i = 0; i < maxTicks; i++) {
      const p = bot.entity.position
      const dx = x - p.x
      const dz = z - p.z
      if (Math.hypot(dx, dz) < tolerance) break
      const yaw = Math.atan2(-dx, -dz)
      await bot.look(yaw, 0, true)
      bot.setControlState('forward', true)
      await bot.waitForTicks(1)
      bot.setControlState('forward', false)
    }
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('sneak', false)
    bot.clearControlStates()
  }
  const p = bot.entity.position
  const err = Math.hypot(x - p.x, z - p.z)
  if (err >= tolerance) log.warn(`moveToExact: ended ${err.toFixed(3)} from target`)
  return err
}

module.exports = { setup, goto, moveToExact, sleep, Vec3 }
