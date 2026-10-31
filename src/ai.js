// "!slicer ask <question>" — answers questions about the bot using Claude.
// The API key is read from an environment variable (never from config.json).
// The model only sees a status snapshot and can only reply with text; it cannot
// make the bot do anything.
const log = require('./logger')
const state = require('./state')
const inv = require('./inventory')
const plan = require('./plan')

const history = new Map() // user -> last few Q/A turns, for follow-up questions
const lastAsk = new Map() // user -> timestamp
let hourWindow = { start: Date.now(), count: 0 }

const SYSTEM = [
  'You are the status voice of a Minecraft bot that slices nether portals in the nether.',
  'For each portal it: lights it with a fire charge, places two iron trapdoors and a redstone block,',
  'mines the redstone (the trapdoors must stay open = update suppression worked), mines two frame obsidian,',
  'removes the trapdoors, then moves 1 block east. 9 portals per unit, 20 units per row, 50 rows.',
  'It restocks redstone blocks, fire charges, trapdoors, porkchops and pickaxes at a hub when low.',
  'Answer ONLY from the snapshot you are given. If the snapshot does not say, say you do not know.',
  'Reply in plain text, no markdown, at most 2 short sentences (under 200 characters),',
  'in the same language as the question.'
].join(' ')

function snapshot (bot, cfg, ctx) {
  const s = state.get()
  const total = plan.total(cfg)
  const p = plan.portalAt(cfg, Math.min(s.portalIndex, total - 1))
  const pick = inv.bestPickaxe(bot)
  const recent = log.recent(80)
    .filter(l => !l.includes('[Server/chat]')) // keep other players' chat out of the prompt
    .slice(-40)
  const dmg = (ctx.damageHistory || []).slice(-5).map(d => `${d.time} ${d.from ?? '?'}->${d.to ?? '?'} ${d.source || ''}`)
  return [
    `Now: ${new Date().toISOString()}`,
    `Running: ${s.running ? 'yes' : 'no'}, status: ${s.status}, paused: ${ctx.paused ? 'yes' : 'no'}`,
    `Current portal: #${s.portalIndex + 1} of ${total} (row ${p.row + 1}/${cfg.slicing.rows}, unit ${p.unit + 1}/${cfg.slicing.unitsPerRow}, portal ${p.portal + 1}/${cfg.slicing.portalsPerUnit}) at ${p.anchor.join(' ')}, step "${s.step}"`,
    `Completed: ${s.completedPortals}, failed (portal broke): ${(s.failedPortals || []).join(', ') || 'none'}`,
    `Last restock: ${s.lastRestockAt || 'never'}`,
    `Position: ${bot.entity ? bot.entity.position.floored() : 'not spawned'} in ${bot.game?.dimension ?? '?'}`,
    `Health ${Math.round(bot.health ?? 0)}/20, food ${bot.food ?? '?'}/20`,
    `Inventory: ${inv.summary(bot)}; pickaxe durability ${pick ? pick.remaining : 'none'}; totem in offhand: ${bot.inventory?.slots?.[45]?.name === 'totem_of_undying' ? 'yes' : 'no'}`,
    `Recent damage: ${dmg.join(' | ') || 'none'}`,
    'Recent log (oldest first):',
    ...recent
  ].join('\n')
}

// Returns the reply text (never throws).
async function ask (bot, cfg, ctx, user, question) {
  const ai = cfg.ai || {}
  const key = process.env[ai.apiKeyEnv || 'ANTHROPIC_API_KEY']
  if (!ai.enabled) return 'AI answers are turned off (ai.enabled in config.json).'
  if (!key) return `No API key: set ${ai.apiKeyEnv || 'ANTHROPIC_API_KEY'} before starting the bot.`
  if (!question.trim()) return `Usage: ${cfg.chatPrefix} ask <question>`

  const now = Date.now()
  const wait = (ai.cooldownSeconds ?? 10) * 1000 - (now - (lastAsk.get(user) || 0))
  if (wait > 0) return `Wait ${Math.ceil(wait / 1000)}s before asking again.`
  if (now - hourWindow.start > 3600e3) hourWindow = { start: now, count: 0 }
  if (hourWindow.count >= (ai.maxPerHour ?? 60)) return 'Hourly AI question limit reached.'
  lastAsk.set(user, now)
  hourWindow.count++

  const past = history.get(user) || []
  const messages = [
    ...past,
    { role: 'user', content: `Status snapshot:\n${snapshot(bot, cfg, ctx)}\n\nQuestion from ${user}: ${question}` }
  ]
  try {
    const res = await fetch(`${ai.baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ai.model, max_tokens: ai.maxTokens ?? 200, system: SYSTEM, messages }),
      signal: AbortSignal.timeout(20000)
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      log.warn(`AI request failed: HTTP ${res.status} ${body?.error?.message ?? ''}`)
      return `AI error (HTTP ${res.status}). Check the API key and logs/bot.log.`
    }
    const text = (body.content || []).filter(c => c.type === 'text').map(c => c.text).join(' ')
      .replace(/\s+/g, ' ').trim() || '(no answer)'
    // remember only the question + answer (not the big snapshot) for follow-ups
    history.set(user, [...past, { role: 'user', content: question }, { role: 'assistant', content: text }].slice(-6))
    log.info(`AI answer to ${user}: ${text}`)
    return text
  } catch (e) {
    log.warn('AI request failed:', e.message)
    return 'AI request failed (network/timeout).'
  }
}

module.exports = { ask, snapshot }
