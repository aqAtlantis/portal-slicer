// Hub restock uses positions configured locally in config.json.
const log = require('./logger')
const inv = require('./inventory')
const state = require('./state')
const { moveToExact, goto, sleep, Vec3 } = require('./movement')
const { digExact } = require('./dig')

const v = a => (a ? new Vec3(a[0], a[1], a[2]) : null)
const isShulker = name => /shulker_box$/.test(name || '')

// How many of `itemName` a shulker-box ITEM holds (null = can't tell).
// Contents of a shulker-box ITEM. An emptied box has no "container" component at all,
// so a known component map without it means EMPTY (null = can't tell).
function boxContents (item) {
  if (!item.componentMap) return null
  const data = item.componentMap.get('container')?.data
  if (data === undefined) return []
  return data?.contents ?? (Array.isArray(data) ? data : [])
}
function boxHolds (bot, item, itemName) {
  const contents = boxContents(item)
  if (!contents) return null
  const id = bot.registry.itemsByName[itemName].id
  return contents.reduce((n, e) => {
    if (!e) return n
    const eid = e.itemId ?? e.item ?? e.id
    return eid === id ? n + (e.itemCount ?? e.count ?? 1) : n
  }, 0)
}

// true if a shulker-box ITEM is known to be empty
function boxEmpty (item) {
  const contents = boxContents(item)
  return Array.isArray(contents) && contents.every(e => !e || (e.itemCount ?? e.count ?? 0) === 0)
}
const stationChests = st => (st.chests || [st.chest]).map(v)

const countIn = (win, name) => win.containerItems().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)

async function withContainer (bot, ctx, pos, fn) {
  // the server only lets players open containers within reach, so walk closer if needed
  const eye = bot.entity.position.offset(0, 1.62, 0)
  if (eye.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.2) await goto(bot, pos.x, pos.y, pos.z, 2, 30000)
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
  const target = v(station.target)
  let got = false
  for (const chest of stationChests(station)) {
    await withContainer(bot, ctx, chest, async win => {
      const boxes = win.containerItems().filter(i => isShulker(i.name))
        .map(i => ({ i, holds: boxHolds(bot, i, itemName) }))
        .filter(b => b.holds !== 0) // skip boxes we know are empty
        .sort((a, b) => (b.holds ?? 1) - (a.holds ?? 1))
      if (!boxes.length) return
      await takeSlot(bot, boxes[0].i.slot)
      got = true
    })
    if (got) break
  }
  if (!got) return false
  await moveToExact(bot, ...cfg.hub.stand)

  await ctx.lock.run(async () => {
    const box = bot.inventory.items().filter(i => isShulker(i.name) && !boxEmpty(i) && boxHolds(bot, i, itemName) !== 0)
      .sort((a, b) => (boxHolds(bot, b, itemName) ?? 0) - (boxHolds(bot, a, itemName) ?? 0))[0]
    if (!box) throw new Error(`no ${itemName} box in inventory to place`)
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

// Throw junk (obsidian from slicing) off the platform edge so the inventory never fills up.
// Anything not on the whitelist is junk (obsidian, empty shulker boxes, stray items).
// Full shulker boxes are kept (the bot may be carrying one to a target block).
function isJunk (cfg, item) {
  const keep = cfg.hub.keepItems || ['netherite_pickaxe', 'fire_charge', 'redstone_block', 'cooked_porkchop', 'iron_trapdoor', 'totem_of_undying']
  if (keep.includes(item.name)) return false
  if (isShulker(item.name)) return boxEmpty(item)
  return true
}

async function disposeJunk (bot, cfg, ctx) {
  const junk = () => bot.inventory.items().filter(i => isJunk(cfg, i))
  if (!junk().length) return
  const before = junk().reduce((n, i) => n + i.count, 0)

  // 1) put it in the junk chest
  if (cfg.hub.junkChest) {
    try {
      await withContainer(bot, ctx, v(cfg.hub.junkChest), async win => {
        const slots = win.items().filter(i => i.slot >= win.inventoryStart && isJunk(cfg, i)).map(i => i.slot)
        for (const slot of slots) await takeSlot(bot, slot)
      })
    } catch (e) { log.warn('hub: could not use the junk chest:', e.message) }
    await moveToExact(bot, ...cfg.hub.stand)
    const left = junk().reduce((n, i) => n + i.count, 0)
    log.info(`hub: put ${before - left} junk items in the junk chest${left ? ` (${left} did not fit)` : ''}`)
    if (!left) return
    log.warn('hub: the junk chest is full — empty it')
  }

  // 2) fallback: throw it off the platform edge
  const spot = findEdge(bot, cfg)
  if (!spot) { log.warn('hub: carrying junk and nowhere to put it'); return }
  await goto(bot, Math.floor(spot.stand[0]), spot.stand[1], Math.floor(spot.stand[2]), 0, 60000)
  await ctx.lock.run(async () => {
    bot.setControlState('sneak', true)
    try {
      await bot.lookAt(v(spot.lookAt), true)
      for (const it of junk()) { await bot.tossStack(it); await bot.waitForTicks(2) }
      await bot.waitForTicks(10)
    } finally { bot.setControlState('sneak', false) }
  })
  log.info('hub: threw the remaining junk off the platform')
  await moveToExact(bot, ...cfg.hub.stand)
}

async function disposeEmptyBox (bot, cfg, ctx, station, boxPos) {
  const blockName = bot.blockAt(boxPos).name
  await ctx.lock.run(() => digExact(bot, boxPos, blockName, cfg))
  // Pick the dropped box up. If it landed out of reach (the trapdoor station is ~3 blocks
  // from the stand), walk over to it.
  const emptyBox = () => bot.inventory.items().find(i => isShulker(i.name) && boxEmpty(i))
  let item = null
  for (let t = 0; t < 30 && !item; t++) { await bot.waitForTicks(1); item = emptyBox() }
  for (let tries = 0; !item && tries < 3; tries++) {
    const drop = Object.values(bot.entities).find(e => e.name === 'item' && e.position &&
      e.position.distanceTo(boxPos.offset(0.5, 0, 0.5)) < 5 && (() => { const d = e.getDroppedItem?.(); return !d || isShulker(d.name) })())
    if (!drop) break
    try { await goto(bot, Math.floor(drop.position.x), Math.floor(drop.position.y), Math.floor(drop.position.z), 0, 15000, 1) } catch (_) {}
    for (let t = 0; t < 30 && !item; t++) { await bot.waitForTicks(1); item = emptyBox() }
  }
  if (!item) {
    log.warn('hub: emptied box was mined but not picked up')
    await moveToExact(bot, ...cfg.hub.stand)
    return
  }

  if (cfg.hub.junkChest) { await disposeJunk(bot, cfg, ctx); return }
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
    await withContainer(bot, ctx, stationChests(station)[0], async win => {
      const it = win.items().find(i => i.slot >= win.inventoryStart && isShulker(i.name) && boxEmpty(i))
      if (it) await takeSlot(bot, it.slot)
    })
    log.info('hub: put the empty box back in its chest (set hub.emptyBoxDisposal to throw it away instead)')
  }
}

async function topUpFromStation (bot, cfg, ctx, itemName, target) {
  const station = cfg.hub.boxStations[itemName]
  const boxPos = v(station.target).offset(0, 1, 0)

  // Carrying more than the target (e.g. the amounts in config were lowered)?
  // Put the extra back so the inventory always has room for everything else.
  const extra = inv.count(bot, itemName) - target
  if (extra > 0) {
    const back = isShulker(bot.blockAt(boxPos)?.name) ? boxPos : stationChests(station)[0]
    try {
      await withContainer(bot, ctx, back, win => win.deposit(bot.registry.itemsByName[itemName].id, null, extra))
      log.info(`hub: put ${extra} extra ${itemName} back`)
    } catch (e) {
      log.warn(`hub: could not put ${extra} extra ${itemName} back: ${e.message}`)
    }
  }

  let need = target - inv.count(bot, itemName)

  let junkCleared = false
  for (let boxes = 0; need > 0 && boxes < 8; boxes++) {
    if (!isShulker(bot.blockAt(boxPos)?.name)) {
      if (!(await placeBoxFromChest(bot, cfg, ctx, station, itemName))) {
        log.warn(`hub: no more ${itemName} boxes left in ${stationChests(station).map(String).join(' / ')}`)
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
    if (inv.freeSlots(bot) === 0 && need > 0) {
      if (!junkCleared) {
        junkCleared = true
        log.warn('hub: inventory full — merging part-stacks, clearing junk and continuing')
        const merged = await ctx.lock.run(() => inv.compact(bot))
        if (merged) log.info(`hub: merged ${merged} part-stacks`)
        await disposeJunk(bot, cfg, ctx)
        continue
      }
      log.warn(`hub: inventory full — slots: ${inv.slotReport(bot)}`)
      break
    }
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
    await disposeJunk(bot, cfg, ctx) // free space first
    const merged = await ctx.lock.run(() => inv.compact(bot))
    if (merged) log.info(`hub: merged ${merged} part-stacks to free slots`)
    if (!(await swapPickaxe(bot, cfg, ctx))) missing.push('netherite pickaxe')

    const T = cfg.restock.targets
    for (const name of Object.keys(h.boxStations)) {
      const short = await topUpFromStation(bot, cfg, ctx, name, T[name])
      if (short > 0) missing.push(`${name} (short ${short})`)
    }
    if (!h.boxStations.iron_trapdoor && h.trapdoorChest) {
      const td = await topUpFrom(bot, ctx, v(h.trapdoorChest), 'iron_trapdoor', T.iron_trapdoor)
      if (td > 0) missing.push(`iron_trapdoor (short ${td})`)
    }

    if (cfg.restock.foodTarget > 0 && h.foodBox) {
      const food = cfg.restock.foodItem
      const short = await topUpFrom(bot, ctx, v(h.foodBox), food, cfg.restock.foodTarget)
      if (short > 0) log.warn(`hub: food short by ${short}`)
    }
  } catch (e) {
    log.error('hub: restock error:', e.message)
    missing.push(e.message)
  }

  try { await disposeJunk(bot, cfg, ctx) } catch (e) { log.warn('hub: final clean-up failed:', e.message) }
  const after = inv.check(bot, cfg)
  const ok = !after.needed && missing.length === 0
  state.save({ status: ok ? 'idle' : 'paused', lastRestockAt: new Date().toISOString() })
  log.info(`hub: restock ${ok ? 'complete' : 'INCOMPLETE'} — ${inv.summary(bot)}${missing.length ? ' | missing: ' + missing.join(', ') : ''}`)
  return { ok, missing }
}

module.exports = { restock, boxHolds }
