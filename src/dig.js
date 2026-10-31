// Precise single-block mining.
// mineflayer's bot.dig() thinks obsidian takes ~75 s with a netherite pickaxe in 26.1
// (bad tool data), so we time the dig ourselves from the real vanilla formula,
// send "finish" the moment it is done, and stop the instant the server confirms
// the block is gone. Exactly one block is ever mined per call.
const log = require('./logger')

const PICK_SPEED = { netherite_pickaxe: 9, diamond_pickaxe: 8 }

function enchantList (item) {
  let data = item?.enchants ?? []
  if (data && !Array.isArray(data)) data = data.enchantments ?? data.levels ?? []
  return Array.isArray(data) ? data : []
}

function efficiencyLevel (bot, item, override) {
  if (Number.isInteger(override)) return override
  for (const e of enchantList(item)) {
    const name = e.name ?? bot.registry.enchantments?.[e.id]?.name ?? ''
    if (/efficiency/i.test(String(name))) return Number(e.lvl ?? e.level ?? 0)
  }
  return 0
}

function effectAmp (bot, name) {
  const eff = Object.entries(bot.registry.effectsByName || {}).find(([n]) => n.toLowerCase() === name.toLowerCase())
  if (!eff) return -1
  const active = bot.entity.effects?.[eff[1].id]
  return active ? active.amplifier : -1
}

// Number of ticks the server needs before it accepts the block as broken.
function digTicks (bot, block, cfg) {
  const item = bot.heldItem
  let speed = 1
  if (item && PICK_SPEED[item.name]) {
    speed = PICK_SPEED[item.name]
    const eff = efficiencyLevel(bot, item, cfg.slicing.efficiencyOverride)
    if (eff > 0) speed += eff * eff + 1
  }
  const haste = effectAmp(bot, 'Haste')
  if (haste >= 0) speed *= 1 + 0.2 * (haste + 1)
  const fatigue = effectAmp(bot, 'MiningFatigue')
  if (fatigue >= 0) speed *= [0.3, 0.09, 0.0027, 0.00081][Math.min(fatigue, 3)]
  if (!bot.entity.onGround) speed /= 5
  const perTick = speed / block.hardness / 30 // obsidian, redstone block and iron trapdoors are all pickaxe blocks
  return perTick >= 1 ? 0 : Math.ceil(1 / perTick)
}

async function equipPickaxe (bot) {
  const picks = bot.inventory.items().filter(i => i.name === 'netherite_pickaxe')
    .sort((a, b) => (a.durabilityUsed || 0) - (b.durabilityUsed || 0))
  if (!picks.length) throw new Error('no netherite pickaxe')
  if (bot.heldItem?.slot !== picks[0].slot) await bot.equip(picks[0], 'hand')
}

function sendDig (bot, status, pos, face = 1) {
  bot._client.write('block_dig', { status, location: pos, face, sequence: 0 })
}

// Mines exactly the block at pos, which must currently be `expected`.
async function digExact (bot, pos, expected, cfg) {
  const block = bot.blockAt(pos)
  if (!block || block.name !== expected) {
    throw new Error(`refusing to dig ${pos}: expected ${expected}, found ${block?.name ?? 'unloaded'}`)
  }
  await equipPickaxe(bot)
  await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true)

  const eventName = `blockUpdate:${pos}`
  for (let attempt = 0; attempt < 2; attempt++) {
    const base = digTicks(bot, block, cfg)
    const ticks = attempt === 0 ? base : Math.ceil(base * 1.3) + 2
    let gone = false
    const onUpdate = (_old, now) => { if (now && now.name !== expected) gone = true }
    bot.on(eventName, onUpdate)
    try {
      sendDig(bot, 0, pos) // start
      bot.swingArm()
      for (let t = 0; t < ticks && !gone; t++) {
        if (t % 5 === 4) bot.swingArm()
        await bot.waitForTicks(1)
      }
      if (!gone && ticks > 0) sendDig(bot, 2, pos) // finish
      // wait for the server to confirm, stop the moment it does
      for (let t = 0; t < 30 && !gone; t++) await bot.waitForTicks(1)
    } finally {
      bot.removeListener(eventName, onUpdate)
    }
    if (gone || bot.blockAt(pos)?.name !== expected) return ticks
    sendDig(bot, 1, pos) // cancel before retrying
    log.warn(`dig ${expected} at ${pos}: server did not confirm after ${ticks} ticks, retrying`)
    await bot.waitForTicks(4)
  }
  throw new Error(`could not break ${expected} at ${pos}`)
}

module.exports = { digExact, digTicks, equipPickaxe, efficiencyLevel }
