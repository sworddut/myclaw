import {describe, expect, it} from 'vitest'
import {InterruptQueue} from '../src/core/interrupt-queue.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('InterruptQueue', () => {
  it('drain returns empty when nothing enqueued', () => {
    const q = new InterruptQueue<string>()
    expect(q.drain()).toEqual([])
    expect(q.pending).toBe(0)
  })

  it('drain collects settled non-null values', async () => {
    const q = new InterruptQueue<string>()
    q.enqueue(Promise.resolve('error-a'))
    q.enqueue(Promise.resolve(null))
    q.enqueue(Promise.resolve('error-b'))

    await delay(10)

    const results = q.drain()
    expect(results).toEqual(['error-a', 'error-b'])
    expect(q.pending).toBe(0)
  })

  it('drain skips unsettled promises', async () => {
    const q = new InterruptQueue<string>()
    q.enqueue(Promise.resolve('fast'))
    q.enqueue(new Promise((resolve) => setTimeout(() => resolve('slow'), 200)))

    await delay(10)

    const results = q.drain()
    expect(results).toEqual(['fast'])
    expect(q.pending).toBe(1)
  })

  it('flush awaits all pending items then drains', async () => {
    const q = new InterruptQueue<string>()
    q.enqueue(new Promise((resolve) => setTimeout(() => resolve('a'), 30)))
    q.enqueue(new Promise((resolve) => setTimeout(() => resolve(null), 20)))
    q.enqueue(new Promise((resolve) => setTimeout(() => resolve('b'), 10)))

    const results = await q.flush()
    expect(results).toEqual(['a', 'b'])
    expect(q.pending).toBe(0)
  })

  it('flush returns empty when all pass (resolve to null)', async () => {
    const q = new InterruptQueue<string>()
    q.enqueue(Promise.resolve(null))
    q.enqueue(Promise.resolve(null))

    const results = await q.flush()
    expect(results).toEqual([])
  })

  it('rejected promises are treated as null (no interrupt)', async () => {
    const q = new InterruptQueue<string>()
    q.enqueue(Promise.reject(new Error('boom')))
    q.enqueue(Promise.resolve('ok'))

    await delay(10)

    const results = q.drain()
    expect(results).toEqual(['ok'])
    expect(q.pending).toBe(0)
  })

  it('pending tracks unresolved count', async () => {
    const q = new InterruptQueue<string>()
    q.enqueue(Promise.resolve('x'))
    q.enqueue(new Promise((resolve) => setTimeout(() => resolve('y'), 100)))

    await delay(10)

    expect(q.pending).toBe(1)
    await q.flush()
    expect(q.pending).toBe(0)
  })

  it('drain is idempotent — second call returns empty', async () => {
    const q = new InterruptQueue<string>()
    q.enqueue(Promise.resolve('once'))

    await delay(10)

    expect(q.drain()).toEqual(['once'])
    expect(q.drain()).toEqual([])
  })
})
