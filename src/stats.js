// Speed and restock estimates for "!slicer stats".
// Times are measured live (since the bot was started); gaps longer than 3 minutes
// between portals count as pauses and are left out.
const inv = require('./inventory')
const state = require('./state')
const plan = require('./plan')

const portalTimes = [] // completion timestamps (ms) of recent portals
const restockDurations = [] // ms per hub trip
const PAUSE_GAP = 3 * 60e3

// Materials and pickaxe durability used per portal, measured from inventory changes
// between portals (mined-back redstone/trapdoors are picked up only sometimes).
let usage = null // { redstone_block, fire_charge, iron_trapdoor, durability } per portal
let lastSnap = null

function snap (bot) {
  const p = inv.bestPickaxe(bot)
  return {
    redstone_block: inv.count(bot, 'redstone_block'),
    fire_charge: inv.count(bot, 'fire_charge'),
    iron_trapdoor: inv.count(bot, 'iron_trapdoor'),
    durability: p ? p.remaining : null
  }
}

// Call after every finished (not skipped) portal.
function recordPortal (bot) {
  portalTimes.push(Date.now())
  if (portalTimes.length > 200) portalTimes.shift()
  const now = snap(bot)
  if (lastSnap) {
    const d = {}
    for (const k of Object.keys(now)) {
      const used = (lastSnap[k] ?? 0) - (now[k] ?? 0)
      // ignore jumps from restocks / pickaxe swaps (negative or huge)
      d[k] = used >= 0 && used < 20 ? used : null
    }
    usage = usage || { redstone_block: 0, fire_charge: 0, iron_trapdoor: 0, durability: 0, n: 0 }
    if (Object.values(d).every(x => x !== null)) {
      for (const k of Object.keys(d)) usage[k] += d[k]
      usage.n++
    }
  }
  lastSnap = now
}

function recordRestock (ms, bot) {
  restockDurations.push(ms)
  if (restockDurations.length > 20) restockDurations.shift()
  lastSnap = snap(bot)
}

// Average seconds per portal over the last 50 portals, pauses removed.
function secondsPerPortal () {
  const t = portalTimes.slice(-51)
  if (t.length < 4) return null
  const gaps = []
  for (let i = 1; i < t.length; i++) {
    const g = t[i] - t[i - 1]
    if (g < PAUSE_GAP) gaps.push(g)
  }
  if (gaps.length < 3) return null
  gaps.sort((a, b) => a - b)
  // drop the slowest 10% (hub trips and one-off retries are counted separately)
  const keep = gaps.slice(0, Math.max(3, Math.ceil(gaps.length * 0.9)))
  return keep.reduce((a, b) => a + b, 0) / keep.length / 1000
}

function perPortalUse () {
  if (usage && usage.n >= 3) {
    return {
      redstone_block: usage.redstone_block / usage.n,
      fire_charge: usage.fire_charge / usage.n,
      iron_trapdoor: usage.iron_trapdoor / usage.n,
      durability: usage.durability / usage.n
    }
  }
  // until measured: what one portal uses if the redstone block and trapdoors are not recovered
  return { redstone_block: 1, fire_charge: 1, iron_trapdoor: 2, durability: 5 }
}

// How many more portals until the restock check fails, and why.
function portalsUntilRestock (bot, cfg) {
  const use = perPortalUse()
  const th = cfg.restock.thresholds
  const now = snap(bot)
  const limits = []
  for (const k of ['redstone_block', 'fire_charge', 'iron_trapdoor']) {
    if (use[k] > 0) limits.push({ what: k.replace('_block', '').replace('_', ' '), n: Math.max(0, Math.floor((now[k] - th[k]) / use[k]) + 1) })
  }
  if (now.durability != null && use.durability > 0) {
    limits.push({ what: 'pickaxe', n: Math.max(0, Math.floor((now.durability - cfg.restock.minPickaxeDurability) / use.durability) + 1) })
  }
  limits.sort((a, b) => a.n - b.n)
  return limits[0] || null
}

function fmtDuration (sec) {
  if (sec == null || !isFinite(sec)) return '?'
  sec = Math.round(sec)
  const d = Math.floor(sec / 86400); const h = Math.floor(sec % 86400 / 3600); const m = Math.floor(sec % 3600 / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m ${sec % 60}s`
}

function fmtClock (ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function summary (bot, cfg) {
  const spp = secondsPerPortal()
  const next = portalsUntilRestock(bot, cfg)
  const restockSec = restockDurations.length
    ? restockDurations.reduce((a, b) => a + b, 0) / restockDurations.length / 1000
    : 60
  const s = state.get()
  const left = plan.total(cfg) - s.portalIndex

  if (!spp) {
    return `Not enough data yet (need ~5 portals since start). Next restock in ~${next ? next.n : '?'} portals (${next ? next.what : '?'} runs low first).`
  }
  // portals between restocks, for the hourly rate including hub trips
  const use = perPortalUse()
  const cycle = Math.max(1, Math.min(
    (cfg.restock.targets.redstone_block - cfg.restock.thresholds.redstone_block) / (use.redstone_block || 1),
    (cfg.restock.targets.fire_charge - cfg.restock.thresholds.fire_charge) / (use.fire_charge || 1),
    (cfg.restock.targets.iron_trapdoor - cfg.restock.thresholds.iron_trapdoor) / (use.iron_trapdoor || 1)
  ))
  const secPerPortalAll = spp + restockSec / cycle
  const perHour = Math.round(3600 / secPerPortalAll)
  const nextSec = next ? next.n * spp : null
  return `~${perHour} portals/hour (${spp.toFixed(1)}s each, hub trips ~${Math.round(restockSec)}s every ~${Math.round(cycle)} portals). ` +
    `Next restock in ~${next ? next.n : '?'} portals (~${fmtDuration(nextSec)}, around ${nextSec != null ? fmtClock(Date.now() + nextSec * 1000) : '?'}) — ${next ? next.what : '?'} runs low first. ` +
    `${left} portals left: ~${fmtDuration(left * secPerPortalAll)} of slicing.`
}

function portalsSince (ms) { return portalTimes.filter(t => t >= ms).length }

module.exports = { portalsSince, recordPortal, recordRestock, summary, secondsPerPortal, portalsUntilRestock }
