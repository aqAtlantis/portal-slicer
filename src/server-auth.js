'use strict'

// Modern Minecraft transmits chat components as NBT. Keep decoding independent
// of the server's language pack so translated EasyAuth keys still work.
function component(value) {
  if (value?.json) return component(value.json)
  if (Array.isArray(value)) return value.map(component)
  if (!value || typeof value !== 'object') return value
  if (typeof value.type === 'string' && Object.hasOwn(value, 'value')) return component(value.value)
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, component(child)]))
}

function componentText(value) {
  const data = component(value)
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return data.map(componentText).join('')
  if (!data || typeof data !== 'object') return ''
  return `${data.text ?? data.fallback ?? data.translate ?? ''}${data.with ? ` ${data.with.map(componentText).join(' ')}` : ''}${componentText(data.extra)}`.replace(/§[0-9a-fk-or]/gi, '')
}

function translations(value) {
  const data = component(value)
  if (Array.isArray(data)) return data.flatMap(translations)
  if (!data || typeof data !== 'object') return []
  return [data.translate, ...Object.values(data).flatMap(translations)].filter(value => typeof value === 'string')
}

function authMessage(message) {
  const keys = translations(message)
  const text = componentText(message)
  const hasKey = expression => keys.some(key => /^text\.easyauth\./i.test(key) && expression.test(key))
  if (hasKey(/(?:^|\.)(?:loginSuccess|registerSuccess|alreadyAuthenticated|validSession|sessionValid|onlineAccount)$/i) || hasKey(/(?:session\.(?:valid|loginSuccess|alreadyAuthenticated)|registration\.success)$/i)) return 'success'
  if (hasKey(/(?:registerRequired|registration\.(?:required|notRegistered|codeRequired|requiredWithGlobalPassword)|notRegistered)$/i)) return 'register'
  if (hasKey(/(?:loginRequired|notAuthenticated)$/i)) return 'login'
  if (hasKey(/(?:wrongPassword|incorrectPassword|timeExpired|otpRequired|otpIncorrect|tooManyAttempts|password\.(?:incorrect|globalIncorrect))$/i)) return 'failure'
  // Fallback for servers that translate messages into literal English text.
  if (/^(?:\[EasyAuth\]\s*)?(?:You are now authenticated\.|You are already authenticated\.|You have a valid session\.|You are using an online account\.)/i.test(text.trim())) return 'success'
  if (/incorrect (?:global )?password|authentication time has expired|too many login attempts|two-factor authentication/i.test(text)) return 'failure'
  if (/use \/register|not (?:yet )?registered/i.test(text)) return 'register'
  if (/not authenticated|use \/login|please (?:log ?in|login)/i.test(text)) return 'login'
  return null
}

function passwordArgument(password) {
  if (!password || /[\r\n\0]/.test(password)) throw new Error('Set a nonempty server password without line breaks.')
  return `"${password.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

class ServerAuth {
  constructor(bot, settings = {}, { env = process.env, log = console.log, onChange = () => {} } = {}) {
    this.bot = bot
    this.settings = { enabled: false, autoLogin: true, passwordEnv: 'MINECRAFT_AUTH_PASSWORD', ...settings }
    this.env = env
    this.log = log
    this.onChange = onChange
    this.authenticated = !this.settings.enabled
    this.spawned = false
    this.attempted = false
    this.required = null
    this.secrets = new Set()
    if (env[this.settings.passwordEnv]) this.secrets.add(env[this.settings.passwordEnv])
  }

  redact(text) {
    let result = String(text)
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      if (secret) result = result.split(secret).join('[redacted]')
    }
    return result.replace(/\/(login|register|l|reg)\s+([^\n]*)/gi, (match, name, args) => {
      // Keep the server's command syntax visible when it uses placeholders.
      return args.trim().startsWith('<') ? match : `/${name} [redacted]`
    })
  }

  change(authenticated) {
    this.authenticated = authenticated
    this.onChange(authenticated)
  }

  onSpawn() {
    this.spawned = true
    if (this.authenticated) return
    this.change(false)
    if (this.required !== 'register') this.tryAutoLogin()
    if (!this.attempted) this.log('EasyAuth login needed. In this bot terminal, enter /login PASSWORD, or /register PASSWORD PASSWORD if the server asks you to register.')
  }

  tryAutoLogin() {
    if (this.bot._client?.state !== 'play' || typeof this.bot.chat !== 'function' || !this.settings.autoLogin || this.attempted || this.authenticated) return
    const password = this.env[this.settings.passwordEnv]
    if (!password) return
    this.sendRaw(`/login ${passwordArgument(password)}`)
  }

  sendRaw(command) {
    if (!/^\/(?:login|l|register|reg)(?:\s|$)/i.test(command) || /[\r\n\0]/.test(command)) throw new Error('Use /login PASSWORD or /register PASSWORD PASSWORD in the bot terminal.')
    // EasyAuth can withhold the position/chunks that cause Mineflayer's spawn
    // event until registration completes. Chat only needs the play connection.
    if (this.bot._client?.state !== 'play' || typeof this.bot.chat !== 'function') throw new Error('Wait for the server connection to reach the play state before sending a login command.')
    if (command.length > 256) throw new Error('Authentication command is too long.')
    // Keep the command and argument strings out of logs, including server echoes.
    this.secrets.add(command)
    const args = command.match(/"(?:\\.|[^"\\])*"|\S+/g) ?? []
    for (const arg of args.slice(1)) {
      this.secrets.add(arg)
      if (arg.startsWith('"') && arg.endsWith('"')) {
        this.secrets.add(arg.slice(1, -1).replace(/\\(["\\])/g, '$1'))
      }
    }
    this.attempted = true
    this.change(false)
    this.bot.chat(command)
    this.log('Sent authentication command. Waiting for the server to confirm login.')
  }

  handleMessage(message, { position = 'system', sender = null } = {}) {
    // Player chat is never allowed to trigger password transmission or confirm login.
    if (position === 'chat' || sender) return
    const result = authMessage(message)
    if (!result) return
    if (result === 'success') {
      this.required = null
      this.change(true)
      this.log('Server confirmed authentication. Bot commands are available once chunks finish loading.')
      return
    }
    this.settings.enabled = true
    this.change(false)
    this.required = result
    if (result === 'login') this.tryAutoLogin()
    if (result === 'register') this.log('Server requires registration for this account. Enter its /register command in the bot terminal; registration is never automatic.')
    if (result === 'failure') {
      this.attempted = true
      this.log('Authentication failed or needs additional information. Read the server message and enter the correct command in the terminal. No automatic retries.')
    }
  }
}

module.exports = { ServerAuth, component, componentText, translations, authMessage, passwordArgument }
