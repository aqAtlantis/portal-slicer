// Chat commands, same style as the cleric bot ("!bot ..." in chat or /msg Slicer !bot ...).
// Anyone can ask for status; only owners can control it. Replies are whispered to whoever asked.
const log = require('./logger')
const inv = require('./inventory')
const state = require('./state')
const plan = require('./plan')
const ai = require('./ai')
const { component, componentText } = require('./server-auth')

// Same sender lookup as the cleric bot: identity comes from the packet's sender
// field, never from parsing the chat text.
function packetCommand (bot, packet) {
  if (typeof packet.plainMessage !== 'string') return null
  const uuid = String(packet.sender ?? '').replace(/-/g, '').toLowerCase()
  const player = uuid && Object.values(bot.players ?? {}).find(p => String(p.uuid ?? '').replace(/-/g, '').toLowerCase() === uuid)
  if (player) return { username: player.username, message: packet.plainMessage }
  if (uuid && /^0+$/.test(uuid)) return null
  let name = packet.senderName
  if (typeof name === 'string') {
    try { name = JSON.parse(name) } catch { name = { text: name } }
  }
  const username = componentText(component(name))
  if (!/^[a-z0-9_]{1,16}$/i.test(username)) return null
  return { username, message: packet.plainMessage }
}

const s0 = () => state.get()

function setupCommands (bot, cfg, ctx) {
  const prefix = cfg.chatPrefix.toLowerCase()
  const owners = new Set(cfg.owners.map(o => o.toLowerCase()))
  const recent = new Map()

  function reply (user, text, source) {
    if (source === 'terminal' || !ctx.authenticated) { console.log(`[Reply] ${text}`); return }
    for (const chunk of text.match(/.{1,200}/g) ?? []) bot.whisper(user, chunk)
  }

  function statusLine () {
    const s = state.get()
    const p = plan.portalAt(cfg, Math.min(s.portalIndex, plan.total(cfg) - 1))
    const pos = bot.entity ? bot.entity.position.floored() : '?'
    return `[Slicer ${s.running ? 'running' : 'stopped'}/${s.status}] row ${p.row + 1}/${cfg.slicing.rows} unit ${p.unit + 1}/${cfg.slicing.unitsPerRow} ` +
      `portal ${p.portal + 1}/${cfg.slicing.portalsPerUnit} step ${s.step} | done ${s.completedPortals}/${plan.total(cfg)} | ` +
      `hp ${Math.round(bot.health ?? 0)} food ${bot.food ?? '?'} | ${inv.summary(bot)} | at ${pos}`
  }

  async function handle (user, message, source) {
    if (!user || user === bot.username || typeof message !== 'string') return
    const msg = message.trim()
    if (msg.split(/\s+/)[0].toLowerCase() !== prefix) return

    // The same message can arrive as chat, whisper and packet — handle it once.
    const now = Date.now()
    for (const [k, t] of recent) if (now - t > 1000) recent.delete(k)
    const key = `${user.toLowerCase()}\0${msg}`
    if (recent.has(key) && now - recent.get(key) < 250) return
    recent.set(key, now)

    const arg = msg.slice(prefix.length).trim().toLowerCase()
    const isOwner = source === 'terminal' || owners.has(user.toLowerCase())

    if (arg === '' || arg === 'status') return reply(user, statusLine(), source)
    if (arg === 'inv') return reply(user, inv.summary(bot), source)
    if (arg === 'where' || arg === 'pos') {
      return reply(user, bot.entity ? `${bot.entity.position.floored()} in ${bot.game?.dimension}` : 'not spawned', source)
    }
    if (arg === 'help') {
      return reply(user, `${cfg.chatPrefix} [status|inv|where|ask QUESTION|help]  owners: start|once|pause|restock|skip|jump R U P|quit`, source)
    }

    // Free-form questions answered by Claude, e.g. "!slicer ask why did you stop?"
    const raw = msg.slice(prefix.length).trim()
    if (/^ask(\s|$)/i.test(raw)) {
      if (!isOwner && !cfg.ai?.allowEveryone) return reply(user, 'Only my owners can ask me questions.', source)
      const answer = await ai.ask(bot, cfg, ctx, user, raw.replace(/^ask\s*/i, ''))
      return reply(user, answer, source)
    }

    if (!isOwner) return reply(user, 'Only my owners can do that.', source)
    log.info(`command from ${user} (${source}): ${arg}`)
    const [cmd, ...rest] = arg.split(/\s+/)

    if (cmd === 'start' || cmd === 'resume' || cmd === 'once') {
      ctx.paused = false
      ctx.onceMode = cmd === 'once'
      state.save({ running: true, status: 'slicing' })
      ctx.wake?.()
      return reply(user, cmd === 'once' ? 'Slicing ONE portal, then stopping.' : 'Slicing started.', source)
    }
    if (cmd === 'pause' || cmd === 'stop') {
      state.save({ running: false, status: 'paused' })
      return reply(user, 'Will stop after the current step. Progress is saved.', source)
    }
    if (cmd === 'restock') { ctx.forceRestock = true; ctx.wake?.(); return reply(user, 'Will restock before the next portal.', source) }
    if (cmd === 'skip') {
      if (state.get().running) return reply(user, `Pause first (${cfg.chatPrefix} pause).`, source)
      const s = state.save({ portalIndex: s0().portalIndex + 1, step: state.STEPS[0] })
      return reply(user, `Skipped. Next is portal #${s.portalIndex + 1}.`, source)
    }
    if (cmd === 'jump') {
      if (state.get().running) return reply(user, `Pause first (${cfg.chatPrefix} pause).`, source)
      const [r, u, p] = rest.map(Number)
      const S = cfg.slicing
      if (![r, u, p].every(Number.isInteger) || r < 1 || r > S.rows || u < 1 || u > S.unitsPerRow || p < 1 || p > S.portalsPerUnit) {
        return reply(user, `Usage: ${cfg.chatPrefix} jump ROW UNIT PORTAL (1-based)`, source)
      }
      const s = state.save({ portalIndex: plan.indexOf(cfg, r - 1, u - 1, p - 1), step: state.STEPS[0] })
      return reply(user, `Next portal is now #${s.portalIndex + 1} (row ${r}, unit ${u}, portal ${p}).`, source)
    }
    if (cmd === 'quit') { ctx.stopRequested = true; reply(user, 'Logging off.', source); setTimeout(() => bot.quit('owner asked'), 500); return }
    // Anything else with a few words (e.g. "!slicer what are you doing") is treated as a question.
    if (cfg.ai?.enabled && raw.split(/\s+/).length >= 2) return reply(user, await ai.ask(bot, cfg, ctx, user, raw), source)
    reply(user, `Unknown command. Try ${cfg.chatPrefix} help`, source)
  }

  const safe = (u, m, s) => handle(u, m, s).catch(e => log.warn('command error', e.message))
  bot.on('chat', (u, m) => safe(u, m, 'chat'))
  bot.on('whisper', (u, m) => safe(u, m, 'whisper'))
  bot._client.on('playerChat', packet => {
    const c = packetCommand(bot, packet)
    if (c) safe(c.username, c.message, 'packet')
  })

  // Terminal lines like "status" are treated as owner commands.
  return { terminal: text => safe(cfg.owners[0], text.startsWith(cfg.chatPrefix) ? text : `${cfg.chatPrefix} ${text}`, 'terminal') }
}

module.exports = { setupCommands, packetCommand }
