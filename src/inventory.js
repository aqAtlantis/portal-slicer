// Material counting and the "do I need to go to the hub?" check.

const MATERIALS = ['redstone_block', 'iron_trapdoor', 'fire_charge']

function count (bot, name) {
  return bot.inventory.items()
    .filter(i => i.name === name)
    .reduce((n, i) => n + i.count, 0)
}

function pickaxeInfo (item) {
  const max = item.maxDurability || 2031
  const used = item.durabilityUsed || 0
  return { item, used, remaining: max - used, perfect: used === 0 }
}

function pickaxes (bot) {
  return bot.inventory.items()
    .filter(i => i.name === 'netherite_pickaxe')
    .map(pickaxeInfo)
    .sort((a, b) => b.remaining - a.remaining)
}

function bestPickaxe (bot) {
  return pickaxes(bot)[0] || null
}

// Returns { needed: bool, reasons: [], counts, pickaxe }
function check (bot, cfg) {
  const counts = {}
  for (const m of MATERIALS) counts[m] = count(bot, m)
  const pick = bestPickaxe(bot)
  const reasons = []

  for (const m of MATERIALS) {
    const min = cfg.restock.thresholds[m]
    if (counts[m] < min) reasons.push(`${m} ${counts[m]} < ${min}`)
  }
  const food = (cfg.food?.items || []).reduce((n, f) => n + count(bot, f), 0)
  if (cfg.restock.minFood && food < cfg.restock.minFood) reasons.push(`food ${food} < ${cfg.restock.minFood}`)
  if (!pick) reasons.push('no netherite pickaxe')
  else if (pick.remaining < cfg.restock.minPickaxeDurability) {
    reasons.push(`pickaxe durability ${pick.remaining} < ${cfg.restock.minPickaxeDurability}`)
  }

  return {
    needed: reasons.length > 0,
    reasons,
    counts,
    pickaxe: pick ? { remaining: pick.remaining, perfect: pick.perfect } : null
  }
}

function freeSlots (bot) {
  return bot.inventory.emptySlotCount()
}

function summary (bot) {
  const p = bestPickaxe(bot)
  const food = ['golden_carrot', 'cooked_porkchop'].map(f => `${f.replace('cooked_', '')}:${count(bot, f)}`).join(' ')
  return `RS:${count(bot, 'redstone_block')} TD:${count(bot, 'iron_trapdoor')} FC:${count(bot, 'fire_charge')} ` +
    `pick:${p ? p.remaining : 'none'} ${food}`
}

module.exports = { MATERIALS, count, pickaxes, bestPickaxe, pickaxeInfo, check, freeSlots, summary }
