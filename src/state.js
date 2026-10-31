// Persistent memory of where the bot is in the job.
// Written atomically after every change so a crash/disconnect never loses progress
// and the bot never re-slices a finished portal.
const fs = require('fs')
const path = require('path')
const { ROOT } = require('./config')

const DATA_DIR = path.join(ROOT, 'data')
const STATE_FILE = path.join(DATA_DIR, 'state.json')
const LOCKOUT_FILE = path.join(DATA_DIR, 'LOCKOUT')
fs.mkdirSync(DATA_DIR, { recursive: true })

// Order of the work inside ONE portal (phase 3 walks through these).
const STEPS = [
  'light_portal', // fire charge
  'place_trapdoors', // two iron trapdoors
  'place_redstone', // redstone block
  'mine_redstone', // update suppression
  'mine_obsidian_1', // C shape
  'mine_obsidian_2', // final shape
  'remove_trapdoors',
  'done'
]

const DEFAULT_STATE = {
  // index into the global portal list (0 .. rows*units*9 - 1), see plan.js
  portalIndex: 0,
  step: STEPS[0],
  completedPortals: 0,
  // true after "!bot start": the bot keeps slicing, and resumes on its own after a reconnect
  running: false,
  failedPortals: [], // portal numbers whose portal broke completely
  status: 'idle', // idle | restocking | slicing | paused | finished | totem_lockout
  lastRestockAt: null,
  updatedAt: null
}

let state = null

function load () {
  if (state) return state
  try {
    state = { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }
  } catch (_) {
    state = { ...DEFAULT_STATE }
  }
  return state
}

function save (patch = {}) {
  load()
  Object.assign(state, patch, { updatedAt: new Date().toISOString() })
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, STATE_FILE)
  return state
}

function get () { return load() }

function setLockout (reason) {
  fs.writeFileSync(LOCKOUT_FILE, `${new Date().toISOString()} ${reason}\n`)
}
function lockoutReason () {
  try { return fs.readFileSync(LOCKOUT_FILE, 'utf8').trim() } catch (_) { return null }
}
function clearLockout () {
  try { fs.unlinkSync(LOCKOUT_FILE) } catch (_) {}
}

module.exports = { STEPS, STATE_FILE, load, save, get, setLockout, lockoutReason, clearLockout }
