const fs = require('fs')
const path = require('path')
const { ROOT } = require('./config')

const LOG_DIR = path.join(ROOT, 'logs')
fs.mkdirSync(LOG_DIR, { recursive: true })
const MAIN_LOG = path.join(LOG_DIR, 'bot.log')

const ring = []
const RING_SIZE = 300

function stamp () {
  return new Date().toISOString()
}

function log (level, ...parts) {
  const msg = parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')
  const line = `[${stamp()}] [${level}] ${msg}`
  ring.push(line)
  if (ring.length > RING_SIZE) ring.shift()
  console.log(line)
  try { fs.appendFileSync(MAIN_LOG, line + '\n') } catch (_) {}
}

module.exports = {
  LOG_DIR,
  info: (...a) => log('INFO', ...a),
  warn: (...a) => log('WARN', ...a),
  error: (...a) => log('ERROR', ...a),
  recent: (n = 50) => ring.slice(-n),
  // Write a standalone file into logs/ (used for totem and disconnect reports).
  writeReport (name, text) {
    const file = path.join(LOG_DIR, name)
    fs.writeFileSync(file, text)
    return file
  }
}
