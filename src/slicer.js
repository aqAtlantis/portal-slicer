// PHASE 3 — slicing one portal.
// Every step checks the world first, so a step that was already done (before a
// disconnect, or by hand) is skipped instead of repeated. Obsidian is never mined
// unless the update suppression is confirmed (both trapdoors still open with the
// redstone block gone) — that is what keeps a portal from being broken.
const { Vec3 } = require('vec3')
const log = require('./logger')
const state = require('./state')
const plan = require('./plan')
const { moveToExact, sleep } = require('./movement')
const { digExact } = require('./dig')

const STEPS = state.STEPS

function v (a) { return new Vec3(a[0], a[1], a[2]) }

// Absolute positions for one portal.
function geometry (cfg, index) {
  const P = plan.portalAt(cfg, index)
  const t = cfg.slicing.template
  const A = v(P.anchor)
  const at = off => A.offset(off[0], off[1], off[2])
  const interior = []
  for (let dx = t.interior.min[0]; dx <= t.interior.max[0]; dx++) {
    for (let dy = t.interior.min[1]; dy <= t.interior.max[1]; dy++) {
      for (let dz = t.interior.min[2]; dz <= t.interior.max[2]; dz++) interior.push(A.offset(dx, dy, dz))
    }
  }
  return {
    P,
    anchor: A,
    stand: v(P.stand),
    light: { block: at(t.lightClick.block), face: v(t.lightClick.face) },
    trapdoors: [t.trapdoorA, t.trapdoorB].map(d => ({ pos: at(d.pos), click: at(d.clickBlock), face: v(d.face) })),
    redstone: { pos: at(t.redstone.pos), click: at(t.redstone.clickBlock), face: v(t.redstone.face) },
    obsidian: [at(t.obsidian1), at(t.obsidian2)],
    interior
  }
}

const name = (bot, pos) => bot.blockAt(pos)?.name ?? 'unloaded'
const isOpen = b => b && (b.getProperties().open === true || b.getProperties().open === 'true')

async function waitFor (bot, test, ticks = 40) {
  for (let i = 0; i < ticks; i++) {
    if (test()) return true
    await bot.waitForTicks(1)
  }
  return test()
}

async function equipItem (bot, itemName) {
  const it = bot.inventory.items().find(i => i.name === itemName)
  if (!it) throw new Error(`out of ${itemName}`)
  if (bot.heldItem?.name !== itemName) await bot.equip(it, 'hand')
}

// Click a face of `click` with the held item. delta = cursor on that face.
async function useOnFace (bot, click, face, itemName) {
  await equipItem(bot, itemName)
  const ref = bot.blockAt(click)
  if (!ref) throw new Error(`block ${click} not loaded`)
  // cursor: on the clicked face, a quarter of the way up (bottom-half trapdoors), centred sideways
  const delta = new Vec3(
    face.x !== 0 ? (face.x > 0 ? 1 : 0) : 0.5,
    face.y !== 0 ? (face.y > 0 ? 1 : 0) : 0.25,
    face.z !== 0 ? (face.z > 0 ? 1 : 0) : 0.5
  )
  await bot._genericPlace(ref, face, { delta, forceLook: true, swingArm: 'right' })
}

function portalBlocks (bot, g) {
  return g.interior.filter(p => name(bot, p) === 'nether_portal')
}

function trapdoorsOpen (bot, g) {
  return g.trapdoors.every(t => { const b = bot.blockAt(t.pos); return b?.name === 'iron_trapdoor' && isOpen(b) })
}

// ---------------- the steps ----------------

const actions = {
  async light_portal (bot, g) {
    if (portalBlocks(bot, g).length) return 'already lit'
    for (const o of g.obsidian) if (name(bot, o) !== 'obsidian') throw new Error(`frame incomplete: ${o} is ${name(bot, o)}`)
    const blocked = g.interior.filter(p => !['air', 'cave_air', 'fire'].includes(name(bot, p)))
    if (blocked.length) throw new Error(`portal interior not empty at ${blocked[0]} (${name(bot, blocked[0])})`)
    await useOnFace(bot, g.light.block, g.light.face, 'fire_charge')
    if (!(await waitFor(bot, () => name(bot, g.anchor) === 'nether_portal', 40))) throw new Error('portal did not light')
    return 'lit'
  },

  async place_trapdoors (bot, g, cfg) {
    for (const t of g.trapdoors) {
      let b = bot.blockAt(t.pos)
      if (b?.name === 'iron_trapdoor') {
        const pr = b.getProperties()
        if (pr.half === 'bottom' && pr.facing === 'east') continue
        log.warn(`trapdoor at ${t.pos} is ${pr.half}/${pr.facing}, replacing it`)
        await digExact(bot, t.pos, 'iron_trapdoor', cfg)
        b = bot.blockAt(t.pos)
      }
      if (!['air', 'cave_air'].includes(b?.name)) throw new Error(`trapdoor spot ${t.pos} is ${b?.name}`)
      if (name(bot, t.click) !== 'nether_portal') throw new Error(`no portal to click at ${t.click}`)
      await useOnFace(bot, t.click, t.face, 'iron_trapdoor')
      const ok = await waitFor(bot, () => {
        const n = bot.blockAt(t.pos)
        return n?.name === 'iron_trapdoor' && n.getProperties().half === 'bottom' && n.getProperties().facing === 'east'
      })
      if (!ok) throw new Error(`trapdoor at ${t.pos} not placed correctly (${name(bot, t.pos)})`)
    }
    return 'both trapdoors placed (bottom half, facing east)'
  },

  async place_redstone (bot, g) {
    const r = g.redstone
    if (name(bot, r.pos) !== 'redstone_block') {
      if (!['air', 'cave_air'].includes(name(bot, r.pos))) throw new Error(`redstone spot ${r.pos} is ${name(bot, r.pos)}`)
      await useOnFace(bot, r.click, r.face, 'redstone_block')
      if (!(await waitFor(bot, () => name(bot, r.pos) === 'redstone_block'))) throw new Error('redstone block not placed')
    }
    if (!(await waitFor(bot, () => trapdoorsOpen(bot, g), 20))) throw new Error('trapdoors did not open from the redstone block')
    return 'redstone placed, trapdoors open'
  },

  async mine_redstone (bot, g, cfg) {
    if (name(bot, g.redstone.pos) === 'redstone_block') await digExact(bot, g.redstone.pos, 'redstone_block', cfg)
    await bot.waitForTicks(6)
    if (!trapdoorsOpen(bot, g)) {
      const e = new Error('update suppression failed: trapdoors closed after mining the redstone block')
      e.suppressionFailed = true
      throw e
    }
    return 'redstone mined, trapdoors stayed open (suppressed)'
  },

  async mine_obsidian_1 (bot, g, cfg) { return mineObsidian(bot, g, cfg, 0) },
  async mine_obsidian_2 (bot, g, cfg) { return mineObsidian(bot, g, cfg, 1) },

  async remove_trapdoors (bot, g, cfg) {
    for (const t of g.trapdoors) {
      if (name(bot, t.pos) === 'iron_trapdoor') await digExact(bot, t.pos, 'iron_trapdoor', cfg)
    }
    return 'trapdoors removed'
  }
}

async function mineObsidian (bot, g, cfg, i) {
  const pos = g.obsidian[i]
  if (name(bot, pos) !== 'obsidian') return 'already mined'
  // Safety gate: never slice without confirmed suppression.
  if (name(bot, g.redstone.pos) !== 'air' && name(bot, g.redstone.pos) !== 'cave_air') throw new Error('redstone block still present')
  if (!trapdoorsOpen(bot, g)) throw new Error('trapdoors are not open — suppression not active, refusing to mine obsidian')
  if (!portalBlocks(bot, g).length) throw new Error('portal is gone before slicing')
  await digExact(bot, pos, 'obsidian', cfg)
  return `obsidian ${pos} mined`
}

// ---------------- one portal ----------------

// Returns { ok: bool, remnant: [positions] }. Throws on a step failure.
async function runPortal (bot, cfg, ctx, index) {
  const g = geometry(cfg, index)
  const label = `portal #${index + 1} (row ${g.P.row + 1}, unit ${g.P.unit + 1}, portal ${g.P.portal + 1}) at ${g.anchor}`
  let s = state.get()
  if (s.portalIndex !== index) s = state.save({ portalIndex: index, step: STEPS[0] })

  // Is there really a portal frame here? The corner obsidian above and below the
  // middle row stays after slicing, so it must exist for both sliced and unsliced portals.
  const corners = [[0, 0, -1], [0, 2, -1], [0, 0, 2], [0, 2, 2]].map(d => g.anchor.offset(...d))
  const notFrame = corners.filter(c => name(bot, c) !== 'obsidian')
  if (notFrame.length) {
    throw new Error(`${label}: no portal frame here (${notFrame[0]} is ${name(bot, notFrame[0])}) — check the unit/row spacing in config.json`)
  }

  // Already sliced (by hand, or before memory was saved)? Skip without touching it.
  if (STEPS.indexOf(s.step) <= STEPS.indexOf('place_redstone') &&
      g.obsidian.every(o => ['air', 'cave_air'].includes(name(bot, o)))) {
    log.warn(`${label}: frame already sliced, skipping`)
    return { ok: true, skipped: true, remnant: portalBlocks(bot, g) }
  }

  log.info(`${label}: starting at step "${s.step}"`)
  await moveToExact(bot, g.stand.x, g.stand.y, g.stand.z)
  await bot.waitForTicks(4)

  let retries = cfg.slicing.suppressionRetries
  let i = STEPS.indexOf(s.step)
  while (STEPS[i] !== 'done') {
    if (ctx.shuttingDown) throw new Error('shutting down')
    if (!state.get().running) {
      const e = new Error(`paused before step "${STEPS[i]}"`)
      e.pausedByOwner = true
      throw e
    }
    const step = STEPS[i]
    try {
      const msg = await ctx.lock.run(() => actions[step](bot, g, cfg))
      log.info(`${label}: ${step} — ${msg}`)
      i++
      state.save({ step: STEPS[i], status: 'slicing' })
    } catch (e) {
      if (e.suppressionFailed && retries-- > 0) {
        log.warn(`${label}: ${e.message}. Retrying redstone place + mine (${retries} retries left)`)
        i = STEPS.indexOf('place_redstone')
        state.save({ step: STEPS[i] })
        await sleep(500)
        continue
      }
      e.message = `${label}: ${step} failed — ${e.message}`
      throw e
    }
  }

  const remnant = portalBlocks(bot, g)
  return { ok: remnant.length > 0, remnant }
}

module.exports = { runPortal, geometry, actions }
