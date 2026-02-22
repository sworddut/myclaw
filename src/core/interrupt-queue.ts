type PendingItem<T> = {
  promise: Promise<T | null>
  settled: boolean
  value: T | null
}

/**
 * Generic async interrupt queue.
 *
 * Callers enqueue promises that resolve to either a value (= interrupt needed)
 * or null (= no action).  The agent loop can non-blockingly drain settled
 * results or blocking-flush all pending items before a final return.
 */
export class InterruptQueue<T> {
  private items: PendingItem<T>[] = []

  enqueue(promise: Promise<T | null>): void {
    const item: PendingItem<T> = {promise, settled: false, value: null}
    promise
      .then((v) => {
        item.settled = true
        item.value = v
      })
      .catch(() => {
        item.settled = true
        item.value = null
      })
    this.items.push(item)
  }

  /** Non-blocking: collect all settled non-null results and remove them. */
  drain(): T[] {
    const results: T[] = []
    const remaining: PendingItem<T>[] = []
    for (const item of this.items) {
      if (item.settled) {
        if (item.value) results.push(item.value)
      } else {
        remaining.push(item)
      }
    }
    this.items = remaining
    return results
  }

  /** Blocking: await every pending item then drain. */
  async flush(): Promise<T[]> {
    await Promise.allSettled(this.items.map((i) => i.promise))
    return this.drain()
  }

  get pending(): number {
    return this.items.filter((i) => !i.settled).length
  }
}
