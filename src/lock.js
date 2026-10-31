// Tiny async mutex. Anything that must not be interrupted (an open chest window,
// eating, and in phase 3 each placing/mining step) runs inside lock.run().
class Lock {
  constructor () {
    this._tail = Promise.resolve()
    this.held = false
  }

  run (fn) {
    const next = this._tail.then(async () => {
      this.held = true
      try { return await fn() } finally { this.held = false }
    })
    this._tail = next.catch(() => {})
    return next
  }
}

module.exports = { Lock }
