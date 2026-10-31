// PHASE 2 — the coordinate loop.
// Order: row (z) -> unit (x) -> portal (x). 9 portals x 20 units x 50 rows = 9000.
//
//   portal step : +1 x between portals in a unit
//   unit step   : after the 9th portal, +unitGap (4) x to the 1st portal of the next unit
//                 (3 spacer blocks between units) => unit pitch = (9 - 1) + 4 = 12 blocks
// Example units are calculated from config.json.
//   row step    : +4 z, x goes back to the row-1 start
//
// Run:  node src/plan.js                 summary + test coordinates
//       node src/plan.js --row 1 --unit 1   every portal in that unit (1-based)
//       node src/plan.js --all             all 9000 portals
//       node src/plan.js --csv plan.csv    write all 9000 to a CSV

function S (cfg) { return cfg.slicing }
function total (cfg) { return S(cfg).rows * S(cfg).unitsPerRow * S(cfg).portalsPerUnit }
// distance (in portal steps) from portal 1 of one unit to portal 1 of the next
function unitPitch (cfg) { return (S(cfg).portalsPerUnit - 1) + S(cfg).unitGap }

function offset (cfg, row, unit, portal) {
  const s = S(cfg)
  const along = unit * unitPitch(cfg) + portal // steps along the row
  return [0, 1, 2].map(i => along * s.portalStep[i] + row * s.rowStep[i])
}

function add (a, d) { return [a[0] + d[0], a[1] + d[1], a[2] + d[2]] }

// index 0 .. total-1  ->  { index, row, unit, portal, fireCharge, stand, offset }
function portalAt (cfg, index) {
  const s = S(cfg)
  const perRow = s.unitsPerRow * s.portalsPerUnit
  const row = Math.floor(index / perRow)
  const unit = Math.floor((index % perRow) / s.portalsPerUnit)
  const portal = index % s.portalsPerUnit
  const d = offset(cfg, row, unit, portal)
  const anchor = add(s.fireCharge, d)
  return { index, row, unit, portal, offset: d, anchor, fireCharge: anchor, stand: add(anchor, s.template.stand) }
}

function indexOf (cfg, row, unit, portal) {
  const s = S(cfg)
  return row * s.unitsPerRow * s.portalsPerUnit + unit * s.portalsPerUnit + portal
}

function* all (cfg, from = 0) {
  for (let i = from; i < total(cfg); i++) yield portalAt(cfg, i)
}

module.exports = { total, unitPitch, portalAt, indexOf, all, offset }

// ---------------- CLI ----------------
if (require.main === module) {
  const fs = require('fs')
  const { loadConfig } = require('./config')
  const cfg = loadConfig()
  const args = process.argv.slice(2)
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
  const r3 = a => a.map(v => Number.isInteger(v) ? v : v.toFixed(3)).join(' ')
  const fmt = p => `#${String(p.index + 1).padStart(4)}  row ${String(p.row + 1).padStart(2)}  unit ${String(p.unit + 1).padStart(2)}  ` +
    `portal ${p.portal + 1}   portal block @ ${p.anchor.join(' ')}   bot stands @ ${r3(p.stand)}`

  if (args.includes('--csv')) {
    const file = opt('--csv') || 'plan.csv'
    const lines = ['index,row,unit,portal,fire_x,fire_y,fire_z,stand_x,stand_y,stand_z']
    for (const p of all(cfg)) lines.push([p.index + 1, p.row + 1, p.unit + 1, p.portal + 1, ...p.fireCharge, ...p.stand].join(','))
    fs.writeFileSync(file, lines.join('\n'))
    console.log(`wrote ${total(cfg)} portals to ${file}`)
  } else if (args.includes('--all')) {
    for (const p of all(cfg)) console.log(fmt(p))
  } else if (opt('--row')) {
    const row = Number(opt('--row')) - 1
    const units = opt('--unit') ? [Number(opt('--unit')) - 1] : [...Array(S(cfg).unitsPerRow).keys()]
    for (const u of units) {
      console.log(`--- row ${row + 1}, unit ${u + 1} ---`)
      for (let k = 0; k < S(cfg).portalsPerUnit; k++) console.log(fmt(portalAt(cfg, indexOf(cfg, row, u, k))))
    }
  } else {
    const s = S(cfg)
    console.log(`Total portals: ${total(cfg)}  (${s.portalsPerUnit} per unit x ${s.unitsPerRow} units x ${s.rows} rows)`)
    console.log(`Portal step +${s.portalStep[0]} x | unit pitch ${unitPitch(cfg)} x | row step +${s.rowStep[2]} z\n`)
    console.log('Row 1, unit 1 (all 9):')
    for (let k = 0; k < 9; k++) console.log('  ' + fmt(portalAt(cfg, indexOf(cfg, 0, 0, k))))
    console.log('\nUnit boundary (row 1):')
    console.log('  ' + fmt(portalAt(cfg, indexOf(cfg, 0, 0, 8))))
    console.log('  ' + fmt(portalAt(cfg, indexOf(cfg, 0, 1, 0))))
    console.log('  ' + fmt(portalAt(cfg, indexOf(cfg, 0, 2, 0))))
    console.log('\nRow boundary:')
    console.log('  ' + fmt(portalAt(cfg, indexOf(cfg, 0, 19, 8))))
    console.log('  ' + fmt(portalAt(cfg, indexOf(cfg, 1, 0, 0))))
    console.log('  ' + fmt(portalAt(cfg, indexOf(cfg, 2, 0, 0))))
    console.log('\nVery last portal:')
    console.log('  ' + fmt(portalAt(cfg, total(cfg) - 1)))
  }
}
