// Hub restock uses coordinates from config.json.`r`n`r`nconst v = a => (a ? new Vec3(a[0], a[1], a[2]) : null)
const isShulker = name => /shulker_box$/.test(name || '')

// How many of `itemName` a shulker-box ITEM holds (null = can't tell).
function boxHolds (bot, item, itemName) {
  const data = item.componentMap?.get('container')?.data
  const contents = data?.contents ?? (Array.isArray(data) ? data : null)
  if (!contents) return null
  const id = bot.registry.itemsByName[itemName].id
  return contents.reduce((n, e) => {
    if (!e) return n
    const eid = e.itemId ?? e.item ?? e.id
    return eid === id ? n + (e.itemCount ?? e.count ?? 1) : n
  }, 0)
}

const countIn = (win, name) => win.containerItems().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)

async function withContainer (bot, ctx, pos, fn) {
  return ctx.lock.run(async () => {
    const block = bot.blockAt(pos)
    if (!block) throw new Error(`no block loaded at ${pos}`)
    const win = await bot.openContainer(block)
    try { return await fn(win) } finally { win.close(); await sleep(250) }
  })
}

// Shift-click container slots into the inventory.
async function takeSlot (bot, slot) {
  await bot.clickWindow(slot, 0, 1)
  await sleep(150)
}

async function withdrawUpTo (bot, win, name, need) {
  const take = Math.min(need, countIn(win, name), inv.freeSlots(bot) * 64)
  if (take > 0) await win.withdraw(bot.registry.itemsByName[name].id, null, take)
  return take
}

// ---------------- pickaxe ----------------

async function swapPickaxe (bot, cfg, ctx) {
  const best = inv.bestPickaxe(bot)
  if (best && best.remaining >= cfg.hub.swapPickaxeBelow) return true
  const chest = v(cfg.hub.pickaxeChest)
  let ok = false
  await withContainer(bot, ctx, chest, async win => {
    // 1) take the best pickaxe in the chest (perfect if there is one)
    const picks = win.containerItems().filter(i => i.name === 'netherite_pickaxe')
      .sort((a, b) => (a.durabilityUsed || 0) - (b.durabilityUsed || 0))
    const pick = picks[0]
    const cur = best ? best.remaining : -1
    const theirs = pick ? (pick.maxDurability || 2031) - (pick.durabilityUsed || 0) : -1
    if (!pick || theirs <= cur) { log.warn('hub: no better pickaxe in the chest'); return }
    await takeSlot(bot, pick.slot)
    // 2) put the worn one(s) back in the same chest
    const worn = win.items().filter(i => i.slot >= win.inventoryStart && i.name === 'netherite_pickaxe' &&
      (i.maxDurability || 2031) - (i.durabilityUsed || 0) < cfg.hub.swapPickaxeBelow)
    for (const w of worn) await takeSlot(bot, w.slot)
    ok = true
  })
  if (ok) log.info(`hub: pickaxe swapped, now ${inv.bestPickaxe(bot)?.remaining} durability`)
  return inv.bestPickaxe(bot)?.remaining >= cfg.restock.minPickaxeDurability
}

// ---------------- plain containers (trapdoors, food) ----------------

async function topUpFrom (bot, ctx, pos, name, target) {
  let need = target - inv.count(bot, name)
  if (need <= 0) return 0
  await withContainer(bot, ctx, pos, async win => { await withdrawUpTo(bot, win, name, need) })
  need = target - inv.count(bot, name)
  return Math.max(0, need)
}

// ---------------- shulker box stations (redstone, fire charges) ----------------

async function placeBoxFromChest (bot, cfg, ctx, station, itemName) {
  const chest = v(station.chest)
  const target = v(station.target)
  let got = false
  await withContainer(bot, ctx, chest, async win => {
    const boxes = win.containerItems().filter(i => isShulker(i.name))
      .map(i => ({ i, holds: boxHolds(bot, i, itemName) }))
      .filter(b => b.holds !== 0) // skip boxes we know are empty
      .sort((a, b) => (b.holds ?? 1) - (a.holds ?? 1))
    if (!boxes.length) return
    await takeSlot(bot, boxes[0].i.slot)
    got = true
  })
  if (!got) return false

  await ctx.lock.run(async () => {
    const box = bot.inventory.items().find(i => isShulker(i.name) && boxHolds(bot, i, itemName) !== 0)
    await bot.equip(box, 'hand')
    await bot._genericPlace(bot.blockAt(target), new Vec3(0, 1, 0), { forceLook: true, swingArm: 'right' })
  })
  const boxPos = target.offset(0, 1, 0)
  for (let t = 0; t < 40 && !isShulker(bot.blockAt(boxPos)?.name); t++) await bot.waitForTicks(1)
  if (!isShulker(bot.blockAt(boxPos)?.name)) throw new Error(`could not place the ${itemName} box on the target block`)
  log.info(`hub: placed a new ${itemName} box at ${boxPos}`)
  return true
}

// Nearest platform edge north, south or west of the hub stand: walks outwards
// along the floor until there is a drop of 3+ blocks. Cached after the first find.
let edgeCache = null
function findEdge (bot, cfg) {
  if (edgeCache) return edgeCache
  const s = v(cfg.hub.stand).floored()
  const passable = p => { const b = bot.blockAt(p); return b && b.boundingBox === 'empty' }
  let best = null
  for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0]]) { // north, south, west
    for (let k = 1; k <= 16; k++) {
      const feet = s.offset(dx * k, 0, dz * k)
      if (!passable(feet) || !passable(feet.offset(0, 1, 0))) break // wall or chest in the way
      if (passable(feet.offset(0, -1, 0)) && passable(feet.offset(0, -2, 0)) && passable(feet.offset(0, -3, 0))) {
        if (k > 1 && (!best || k < best.k)) {
          const last = s.offset(dx * (k - 1), 0, dz * (k - 1))
          best = {
            k,
            stand: [last.x + 0.5, last.y, last.z + 0.5],
            lookAt: [feet.x + 0.5 + dx * 2, feet.y, feet.z + 0.5 + dz * 2] // a bit past the edge, slightly down
          }
        }
        break
      }
    }
  }
  if (best) log.info(`hub: found the platform edge ${best.k} blocks away, will throw empty boxes from ${best.stand.join(' ')}`)
  else log.warn('hub: no platform edge found north/south/west of the hub within 16 blocks')
  edgeCache = best
  return best
}

async function disposeEmptyBox (bot, cfg, ctx, station, boxPos) {
  const blockName = bot.blockAt(boxPos).name
  await ctx.lock.run(() => digExact(bot, boxPos, blockName, cfg))
  // it drops right next to the bot and is picked up automatically
  let item = null
  for (let t = 0; t < 60 && !item; t++) {
    await bot.waitForTicks(1)
    item = bot.inventory.items().find(i => isShulker(i.name) && !(boxHolds(bot, i, 'redstone_block') || boxHolds(bot, i, 'fire_charge')))
  }
  if (!item) { log.warn('hub: emptied box was mined but not picked up'); return }

  const d = cfg.hub.emptyBoxDisposal || {}
  const spot = (d.stand && d.lookAt) ? { stand: d.stand, lookAt: d.lookAt } : (d.auto !== false ? findEdge(bot, cfg) : null)
  if (spot) {
    await goto(bot, Math.floor(spot.stand[0]), spot.stand[1], Math.floor(spot.stand[2]), 0, 60000)
    await ctx.lock.run(async () => {
      bot.setControlState('sneak', true) // can't walk off the edge while sneaking
      try {
        await bot.lookAt(v(spot.lookAt), true)
        await bot.tossStack(item)
        await bot.waitForTicks(10)
      } finally { bot.setControlState('sneak', false) }
    })
    log.info(`hub: threw the empty box off the platform from ${spot.stand.join(' ')}`)
    await moveToExact(bot, ...cfg.hub.stand)
  } else {
    // No throw spot configured yet: put it back in its chest (it is skipped later because it is empty).
    await withContainer(bot, ctx, v(station.chest), async win => {
      const it = win.items().find(i => i.slot >= win.inventoryStart && i.type === item.type && !boxHolds(bot, i, 'redstone_block') && !boxHolds(bot, i, 'fire_charge'))
      if (it) await takeSlot(bot, it.slot)
    })
    log.info('hub: put the empty box back in its chest (set hub.emptyBoxDisposal to throw it away instead)')
  }
}

async function topUpFromStation (bot, cfg, ctx, itemName, target) {
  const station = cfg.hub.boxStations[itemName]
  const boxPos = v(station.target).offset(0, 1, 0)
  let need = target - inv.count(bot, itemName)

  for (let boxes = 0; need > 0 && boxes < 8; boxes++) {
    if (!isShulker(bot.blockAt(boxPos)?.name)) {
      if (!(await placeBoxFromChest(bot, cfg, ctx, station, itemName))) {
        log.warn(`hub: no more ${itemName} boxes in the chest at ${station.chest.join(' ')}`)
        break
      }
    }
    let left = 0
    await withContainer(bot, ctx, boxPos, async win => {
      await withdrawUpTo(bot, win, itemName, need)
      await sleep(150)
      left = countIn(win, itemName)
    })
    need = target - inv.count(bot, itemName)
    if (left === 0) await disposeEmptyBox(bot, cfg, ctx, station, boxPos)
    if (inv.freeSlots(bot) === 0 && need > 0) { log.warn('hub: inventory full'); break }
  }
  return Math.max(0, need)
}

// ---------------- full restock ----------------

async function restock (bot, cfg, ctx) {
  const h = cfg.hub
  if (!h || !h.stand) {
    log.error('hub.stand is not set in config.json — cannot restock')
    return { ok: false, missing: ['hub not configured'] }
  }
  state.save({ status: 'restocking' })
  log.info('hub: walking to the hub at', h.stand.join(' '))
  await goto(bot, Math.floor(h.stand[0]), h.stand[1], Math.floor(h.stand[2]), 1, 300000)
  await moveToExact(bot, ...h.stand)

  const missing = []
  try {
    if (!(await swapPickaxe(bot, cfg, ctx))) missing.push('netherite pickaxe')

    const T = cfg.restock.targets
    for (const name of Object.keys(h.boxStations)) {
      const short = await topUpFromStation(bot, cfg, ctx, name, T[name])
      if (short > 0) missing.push(`${name} (short ${short})`)
    }
    const td = await topUpFrom(bot, ctx, v(h.trapdoorChest), 'iron_trapdoor', T.iron_trapdoor)
    if (td > 0) missing.push(`iron_trapdoor (short ${td})`)

    if (cfg.restock.foodTarget > 0 && h.foodBox) {
      const food = cfg.restock.foodItem
      const short = await topUpFrom(bot, ctx, v(h.foodBox), food, cfg.restock.foodTarget)
      if (short > 0) log.warn(`hub: food short by ${short}`)
    }
  } catch (e) {
    log.error('hub: restock error:', e.message)
    missing.push(e.message)
  }

  const after = inv.check(bot, cfg)
  const ok = !after.needed && missing.length === 0
  state.save({ status: ok ? 'idle' : 'paused', lastRestockAt: new Date().toISOString() })
  log.info(`hub: restock ${ok ? 'complete' : 'INCOMPLETE'} — ${inv.summary(bot)}${missing.length ? ' | missing: ' + missing.join(', ') : ''}`)
  return { ok, missing }
}

module.exports = { restock, boxHolds }
