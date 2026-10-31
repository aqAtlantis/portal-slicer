const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const CONFIG_FILE = path.join(ROOT, 'config.json')

function loadConfig () {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
}

// Returns a list of problems that stop the bot from logging in.
function validateForLogin (cfg) {
  const problems = []
  const c = cfg.connection || {}
  if (!c.host || c.host === 'SET_SERVER_ADDRESS') problems.push('connection.host is not set')
  if (!c.username) problems.push('connection.username is not set')
  if (!Array.isArray(cfg.owners) || cfg.owners.length === 0) problems.push('owners is empty')
  if (cfg.owners && c.username && cfg.owners.some(o => o.toLowerCase() === c.username.toLowerCase())) {
    problems.push('the bot username must not be one of the owners')
  }
  return problems
}

module.exports = { ROOT, loadConfig, validateForLogin }
