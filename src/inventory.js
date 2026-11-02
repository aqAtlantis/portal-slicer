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
  const keep = cfg.hub?.keepItems || ['netherite_pickaxe', 'fire_charge', 'redstone_block', 'cooked_porkchop', 'iron_trapdoor', 'totem_of_undying']
  const junk = bot.inventory.items().filter(i => !keep.includes(i.name) && !/shulker_box$/.test(i.name)).length
  if (junk > 0 && freeSlots(bot) < 2) reasons.push(`inventory nearly full (${junk} junk stacks)`)
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

// Merge part-used stacks of the same item (e.g. three stacks of 20, 30 and 50 redstone
// become one of 64 and one of 36). Uses inventory clicks, so no container may be open.
async function compact (bot) {
  let merges = 0
  const names = [...new Set(bot.inventory.items().filter(i => i.stackSize > 1).map(i => i.name))]
  for (const name of names) {
    for (let guard = 0; guard < 40; guard++) {
      const parts = bot.inventory.items().filter(i => i.name === name && i.count < i.stackSize)
        .sort((a, b) => a.count - b.count)
      if (parts.length < 2) break
      const from = parts[0]
      const to = parts[parts.length - 1]
      await bot.clickWindow(from.slot, 0, 0) // pick up the smallest part-stack
      await bot.clickWindow(to.slot, 0, 0) // drop it on the biggest one (merges up to 64)
      if (bot.inventory.selectedItem) await bot.clickWindow(from.slot, 0, 0) // put back what didn't fit
      merges++
    }
  }
  return merges
}

// One line per used slot, for the log when the inventory is unexpectedly full.
function slotReport (bot) {
  return bot.inventory.items().map(i => `${i.slot}:${i.name}x${i.count}`).join(' ')
}

module.exports = { compact, slotReport, MATERIALS, count, pickaxes, bestPickaxe, pickaxeInfo, check, freeSlots, summary }
