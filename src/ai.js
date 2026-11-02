// Chat personality: answers "!slicer ask ...", whispers, and public mentions of the bot,
// plus the hourly work report. Works with any Anthropic-compatible API (Claude, or
// DeepSeek via https://api.deepseek.com/anthropic). The API key is read from an
// environment variable. The model can only reply with text; it cannot control the bot.
const log = require('./logger')
const state = require('./state')
const inv = require('./inventory')
const plan = require('./plan')
const stats = require('./stats')

const history = new Map() // user -> last few Q/A turns, for follow-up questions
const lastAsk = new Map() // user -> timestamp
let hourWindow = { start: Date.now(), count: 0 }

function systemPrompt (cfg, bot) {
  const name = cfg.ai?.persona || bot.username
  return [
    `You are ${name}, a hard-working Minecraft bot on a small survival server, chatting with the players in game chat.`,
    'Your job: slicing thousands of nether portals in the nether, one after another (fire charge to light it,',
    'two iron trapdoors and a redstone block for update suppression, mine two frame obsidian, clean up, move 1 block east;',
    '9 portals per unit, 20 units per row, 50 rows). You walk back to a hub to restock redstone, fire charges,',
    'trapdoors, porkchops and pickaxes when you run low.',
    `Facts about you: your owners are ${(cfg.owners || []).join(' and ')}; ${cfg.ai?.creator ? `you were made by ${cfg.ai.creator}` : `they set you up and run you`}. ` +
    'Never invent names of people, players, creators or places; only mention players who are in the conversation or listed here. ' +
    'If you do not know something about yourself or the server, say so casually instead of making it up.',
    'Personality: friendly, relaxed, a bit of dry humour about your endless shift; talk like a regular player, not a status screen.',
    'You may chat about anything (greetings, jokes, Minecraft tips, small talk). Use the status notes only when they matter to',
    'what was asked; never recite the whole status, never mention "snapshot", "log" or "data", and never invent numbers about',
    'your work that the notes do not give. If someone asks you to do something (stop, come here, give items), say kindly that',
    `only your owners can control you with ${cfg.chatPrefix} commands.`,
    'Plain text only, no markdown or emoji spam, at most 2 short sentences (under 200 characters), in the same language as the message.'
  ].join(' ')
}

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
    `Speed/restock estimate: ${(() => { try { return stats.summary(bot, cfg) } catch (_) { return 'n/a' } })()}`,
    `Fragile obsidian (1-tick obsidian mining): ${s.fragileObsidian ? 'on' : 'off'}`,
    `Position: ${bot.entity ? bot.entity.position.floored() : 'not spawned'} in ${bot.game?.dimension ?? '?'}`,
    `Health ${Math.round(bot.health ?? 0)}/20, food ${bot.food ?? '?'}/20`,
    `Inventory: ${inv.summary(bot)}; pickaxe durability ${pick ? pick.remaining : 'none'}; totem in offhand: ${bot.inventory?.slots?.[45]?.name === 'totem_of_undying' ? 'yes' : 'no'}`,
    `Recent damage: ${dmg.join(' | ') || 'none'}`,
    'Recent log (oldest first):',
    ...recent
  ].join('\n')
}

async function complete (cfg, system, messages, maxTokens) {
  const ai = cfg.ai || {}
  const key = process.env[ai.apiKeyEnv || 'ANTHROPIC_API_KEY']
  if (!key) throw new Error(`no API key in ${ai.apiKeyEnv || 'ANTHROPIC_API_KEY'}`)
  const res = await fetch(`${ai.baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: ai.model, max_tokens: maxTokens ?? ai.maxTokens ?? 200, system, messages }),
    signal: AbortSignal.timeout(20000)
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`HTTP ${res.status} ${body?.error?.message ?? ''}`)
  return (body.content || []).filter(c => c.type === 'text').map(c => c.text).join(' ').replace(/\s+/g, ' ').trim()
}

// Hourly public message about the work done. Falls back to a plain line without the AI.
async function hourlyReport (bot, cfg, ctx, done, total, perHour) {
  const s = state.get()
  const pct = ((s.portalIndex / plan.total(cfg)) * 100).toFixed(1)
  const facts = `In the last hour you sliced ${done} portals (${total} done overall, ${pct}% of all ${plan.total(cfg)}). ` +
    `Current pace: about ${perHour ?? '?'} portals per hour. Currently on row ${plan.portalAt(cfg, Math.min(s.portalIndex, plan.total(cfg) - 1)).row + 1} of ${cfg.slicing.rows}.`
  try {
    const text = await complete(cfg, systemPrompt(cfg, bot), [{
      role: 'user',
      content: `Write your hourly update for public chat, one or two short casual sentences (under 200 characters), ` +
        `mentioning the numbers below naturally. Vary the wording; no greeting like "hey everyone" every time.\n${facts}`
    }], 120)
    if (text) return text
  } catch (e) { log.warn('hourly report AI failed:', e.message) }
  return `Hourly update: sliced ${done} portals this hour, ${total} total (${pct}%). Back to work!`
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
  if (wait > 0) return null // too soon: stay quiet instead of nagging
  if (now - hourWindow.start > 3600e3) hourWindow = { start: now, count: 0 }
  if (hourWindow.count >= (ai.maxPerHour ?? 60)) return null
  lastAsk.set(user, now)
  hourWindow.count++

  const past = history.get(user) || []
  const isOwner = (cfg.owners || []).some(o => o.toLowerCase() === user.toLowerCase())
  const messages = [
    ...past,
    {
      role: 'user',
      content: `(Status notes, for you only:\n${snapshot(bot, cfg, ctx)}\n)\n\n` +
        `${user}${isOwner ? ' (one of your owners)' : ''} says: ${question}`
    }
  ]
  try {
    const text = (await complete(cfg, systemPrompt(cfg, bot), messages)) || '...'
    // remember only the question + answer (not the big snapshot) for follow-ups
    history.set(user, [...past, { role: 'user', content: question }, { role: 'assistant', content: text }].slice(-6))
    log.info(`AI answer to ${user}: ${text}`)
    return text
  } catch (e) {
    log.warn('AI request failed:', e.message)
    return /no API key/.test(e.message) ? `No API key: set ${ai.apiKeyEnv || 'ANTHROPIC_API_KEY'} before starting the bot.` : 'Brain lag, try again in a bit.'
  }
}

module.exports = { ask, snapshot, hourlyReport }
