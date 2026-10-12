/**
 * Rotation-executor acceptance tests.
 *
 * The 429-storm scenarios drive the loop on a virtual clock with an injected
 * `sleep`, so nothing here touches a real timer or a real network.
 */
import { describe, expect, it } from 'vitest'
import { emptyRateLimit, type RateLimitInfo } from '@/providers/rateLimit'
import { ProviderError, type TranslateCall } from '@/providers/types'
import {
  WakeChannel,
  defaultSleep,
  executeWithRotation,
  type BatchTransport,
  type ExecutorHooks,
  type TransportOk,
  type WaitingReason,
} from './executor'
import { KeyPool, type KeySeed } from './keyPool'
import { reasonFor } from './reasons'
import type { BatchLine } from './types'

const T0 = 1_700_000_000_000

function seed(id: string): KeySeed {
  return {
    id,
    provider: 'openrouter',
    nickname: id,
    lastFour: '1234',
    enabled: true,
    secret: `sk-${id}`,
  }
}

function ok(text: string): TransportOk {
  const rate: RateLimitInfo = emptyRateLimit()
  return { text, tokensIn: 12, tokensOut: 8, latencyMs: 5, rate }
}

function lines(count: number): BatchLine[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `proj#42#0#0#l${index}`,
    text: `source line ${index}`,
    pageIndex: 0,
    order: index,
    listMarker: null,
    kind: 'paragraph' as const,
    placeholders: [],
  }))
}

function idsIn(user: string): string[] {
  const ids: string[] = []
  for (const match of user.matchAll(/\[id=([^\]]+)\]/g)) ids.push(match[1])
  return ids
}

function promptFor(ids: string[]): TranslateCall {
  const user = ids.map((id, index) => `${index + 1}. [id=${id}] source line ${index}`).join('\n')
  return { model: 'model-1', system: 'system', user, temperature: 0.2 }
}

function rateLimitError(retryAfterMs: number | null = null): ProviderError {
  return new ProviderError('rate_limit', '429 too many requests', {
    status: 429,
    retryAfterMs,
  })
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return null
  } catch (error: unknown) {
    return error
  }
}

describe('429 rotation', () => {
  it('a 429 storm on key A rotates to key B mid-call and re-runs the same batch with no duplicate or missing lines', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5, backoffBaseMs: 1_000 })
    pool.setKeys([seed('key-a'), seed('key-b')])

    const wanted = lines(3).map((line) => line.id)
    const response = JSON.stringify({ items: wanted.map((id) => ({ id, t: `translated ${id}` })) })
    const call = promptFor(wanted)

    const attempts: Array<{ keyId: string; ids: string[] }> = []
    const transport: BatchTransport = async ({ call: sent, lease }) => {
      attempts.push({ keyId: lease.keyId, ids: idsIn(sent.user) })
      if (lease.keyId === 'key-a') throw rateLimitError(10_000)
      return ok(response)
    }

    let rebuilt = 0
    const result = await executeWithRotation(
      () => {
        rebuilt += 1
        return call
      },
      {
        pool,
        models: ['model-1'],
        transport,
        now: () => clock.now,
        sleep: async () => undefined,
      },
    )

    expect(result.keyId).toBe('key-b')
    expect(result.attempts).toBe(2)
    expect(result.retries).toBe(1)
    expect(result.text).toBe(response)
    expect(rebuilt).toBe(2)
    expect(attempts.map((attempt) => attempt.keyId)).toEqual(['key-a', 'key-b'])
    // Same batch, re-run: every id exactly once and in the original order.
    for (const attempt of attempts) expect(attempt.ids).toEqual(wanted)
    expect(pool.health('key-a', clock.now)).toBe('cooling-down')
  })

  it('a 429 on every key parks the call, reports onWaiting(until, reason) and resumes after the injected sleep', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5, backoffBaseMs: 1_000 })
    pool.setKeys([seed('key-a'), seed('key-b')])

    const sleeps: number[] = []
    const waits: Array<{ until: number; reason: WaitingReason }> = []
    const hooks: ExecutorHooks = {
      onWaiting: (until, reason) => waits.push({ until, reason }),
    }

    let calls = 0
    const transport: BatchTransport = async () => {
      calls += 1
      if (calls <= 2) throw rateLimitError(30_000)
      return ok('{"items":[]}')
    }

    const result = await executeWithRotation(() => promptFor(['only-id']), {
      pool,
      models: ['model-1'],
      transport,
      hooks,
      now: () => clock.now,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock.now += ms
      },
    })

    expect(calls).toBe(3)
    expect(sleeps).toEqual([30_000])
    expect(waits).toEqual([{ until: T0 + 30_000, reason: 'ALL_KEYS_COOLING_DOWN' }])
    expect(clock.now).toBe(T0 + 30_000)
    expect(result.attempts).toBe(3)
    expect(result.retries).toBe(2)
    expect(result.keyId).toBe('key-a')
  })

  it('a quota 429 with no server hint parks on the fallback window with reason QUOTA_EXHAUSTED', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({
      now: () => clock.now,
      random: () => 0.5,
      quotaFallbackMs: 5_000,
    })
    pool.setKeys([seed('key-a')])

    const waits: Array<{ until: number; reason: WaitingReason }> = []
    const sleeps: number[] = []
    let calls = 0
    const transport: BatchTransport = async () => {
      calls += 1
      if (calls === 1) {
        throw new ProviderError('quota', '429 quota exceeded', { status: 429 })
      }
      return ok('{"items":[]}')
    }

    const result = await executeWithRotation(() => promptFor(['only-id']), {
      pool,
      models: ['model-1'],
      transport,
      hooks: { onWaiting: (until, reason) => waits.push({ until, reason }) },
      now: () => clock.now,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock.now += ms
      },
    })

    expect(waits).toEqual([{ until: T0 + 5_000, reason: 'QUOTA_EXHAUSTED' }])
    expect(sleeps).toEqual([5_000])
    expect(result.attempts).toBe(2)
    expect(result.retries).toBe(1)
  })

  it('a quota 429 that names Retry-After waits that window, not the fallback (server wins)', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({
      now: () => clock.now,
      random: () => 0.5,
      quotaFallbackMs: 60 * 60_000,
    })
    pool.setKeys([seed('key-a')])

    const waits: Array<{ until: number; reason: WaitingReason }> = []
    const sleeps: number[] = []
    let calls = 0
    const transport: BatchTransport = async () => {
      calls += 1
      if (calls === 1) {
        throw new ProviderError('quota', '429 quota exceeded, retry after 1s', {
          status: 429,
          retryAfterMs: 1_000,
        })
      }
      return ok('{"items":[]}')
    }

    await executeWithRotation(() => promptFor(['only-id']), {
      pool,
      models: ['model-1'],
      transport,
      hooks: { onWaiting: (until, reason) => waits.push({ until, reason }) },
      now: () => clock.now,
      sleep: async (ms) => {
        sleeps.push(ms)
        clock.now += ms
      },
    })

    // The old `max(fallback, retryAfter)` parked this one-minute wait for the
    // whole hour (L-04). The reason stays QUOTA_EXHAUSTED so the banner and
    // the resume path still name the allowance, not a burst.
    expect(waits).toEqual([{ until: T0 + 1_000, reason: 'QUOTA_EXHAUSTED' }])
    expect(sleeps).toEqual([1_000])
  })
})

describe('bounded waits (no endless park)', () => {
  it('a run that never succeeds surfaces a retryable failure after maxWaitCycles parks', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5, backoffBaseMs: 1_000 })
    pool.setKeys([seed('key-a')])

    const sleeps: number[] = []
    let calls = 0
    const transport: BatchTransport = async () => {
      calls += 1
      throw rateLimitError(10_000)
    }

    const error = await captureError(
      executeWithRotation(() => promptFor(['only-id']), {
        pool,
        models: ['model-1'],
        transport,
        maxWaitCycles: 3,
        now: () => clock.now,
        sleep: async (ms) => {
          sleeps.push(ms)
          clock.now += ms
        },
      }),
    )

    // Three whole wait windows were served; the fourth park refused to start
    // another one (L-05: a run that never succeeds must not park forever).
    expect(calls).toBe(4)
    expect(sleeps).toHaveLength(3)
    if (!(error instanceof ProviderError)) throw new Error('expected a ProviderError')
    expect(error.kind).toBe('rate_limit')
    expect(error.message).toContain('3 consecutive rate-limit windows')
    // The failure is retryable in the UI's vocabulary: the queue pauses with
    // this reason and "Fix & Resume" can run the batch again.
    expect(reasonFor(error).reasonCode).toBe('ALL_KEYS_COOLING_DOWN')
  })

  it('a quota stall fails with QUOTA_EXHAUSTED, not a generic cooling-down error', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5, quotaFallbackMs: 5_000 })
    pool.setKeys([seed('key-a')])

    const transport: BatchTransport = async () => {
      throw new ProviderError('quota', '429 quota exceeded', { status: 429 })
    }

    const error = await captureError(
      executeWithRotation(() => promptFor(['only-id']), {
        pool,
        models: ['model-1'],
        transport,
        maxWaitCycles: 2,
        now: () => clock.now,
        sleep: async (ms) => {
          clock.now += ms
        },
      }),
    )

    if (!(error instanceof ProviderError)) throw new Error('expected a ProviderError')
    expect(error.kind).toBe('quota')
    expect(reasonFor(error).reasonCode).toBe('QUOTA_EXHAUSTED')
  })

  it('a run that parks below the cap and then succeeds is never cut off', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5, backoffBaseMs: 1_000 })
    pool.setKeys([seed('key-a')])

    // One rate-limit park, then recovery — with the cap set low (3) so the
    // test proves the budget only fires on *stalls*, not on healthy waiting.
    let calls = 0
    const transport: BatchTransport = async () => {
      calls += 1
      if (calls === 1) throw rateLimitError(2_000)
      return ok('{"items":[]}')
    }

    const result = await executeWithRotation(() => promptFor(['only-id']), {
      pool,
      models: ['model-1'],
      transport,
      maxWaitCycles: 3,
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms
      },
    })

    expect(result.attempts).toBe(2)
    expect(result.keyId).toBe('key-a')
  })
})

describe('attempt diagnostics', () => {
  it('a timeout rotates like any transient error instead of failing the call', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5, backoffBaseMs: 1_000 })
    pool.setKeys([seed('key-a'), seed('key-b')])

    let calls = 0
    const transport: BatchTransport = async ({ lease }) => {
      calls += 1
      if (lease.keyId === 'key-a') {
        throw new ProviderError('timeout', 'HTTP 408: request timed out', { status: 408 })
      }
      return ok('{"items":[]}')
    }

    const seen: string[] = []
    const result = await executeWithRotation(() => promptFor(['only-id']), {
      pool,
      models: ['model-1'],
      transport,
      now: () => clock.now,
      sleep: async () => undefined,
      hooks: { onAttempt: (info) => seen.push(info.category) },
    })

    // Timeouts cool the key (they do not condemn it) and the call rotates on.
    expect(result.keyId).toBe('key-b')
    expect(calls).toBe(2)
    expect(pool.health('key-a', T0)).toBe('cooling-down')
    expect(seen).toEqual(['timeout', 'ok'])
  })

  it('reports every round trip with category/attempt/usage and never a secret', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5, backoffBaseMs: 1_000 })
    pool.setKeys([seed('key-a'), seed('key-b')])

    // key-a fails with a transient 5xx (cools, does not die) → key-b serves.
    const transport: BatchTransport = async ({ lease }) => {
      if (lease.keyId === 'key-a') throw new ProviderError('server', '503 overloaded', { status: 503 })
      return ok('{"items":[]}')
    }

    const seen: Array<{ attempt: number; model: string; keyId: string; maskedKey: string; durationMs: number; ok: boolean; category: string; tokensIn: number; tokensOut: number; estimatedTokens: number }> = []
    const result = await executeWithRotation(() => promptFor(['only-id']), {
      pool,
      models: ['model-1'],
      transport,
      tokenEstimate: 42,
      now: () => clock.now,
      sleep: async () => undefined,
      hooks: { onAttempt: (info) => seen.push({ ...info }) },
    })

    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({
      attempt: 1,
      model: 'model-1',
      keyId: 'key-a',
      maskedKey: '••••1234',
      ok: false,
      category: 'server',
      tokensIn: 0,
      tokensOut: 0,
      estimatedTokens: 42,
    })
    expect(seen[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(seen[1]).toMatchObject({
      attempt: 2,
      keyId: 'key-b',
      ok: true,
      category: 'ok',
      tokensIn: 12,
      tokensOut: 8,
      estimatedTokens: 42,
    })

    // Secret-safety: the diagnostics carry the masked alias only. The seed's
    // secret (`sk-…`) must not appear anywhere in the records.
    expect(JSON.stringify(seen)).not.toContain('sk-')
    // And the count the run reports matches the records emitted.
    expect(result.attempts).toBe(2)
    expect(result.retries).toBe(1)
  })
})

describe('credential failures', () => {
  it('a 401 marks the key invalid and rotates to the next key', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5 })
    pool.setKeys([seed('key-a'), seed('key-b')])

    const retries: Array<{ keyId: string; kind: string }> = []
    const transport: BatchTransport = async ({ lease }) => {
      if (lease.keyId === 'key-a') {
        throw new ProviderError('unauthorized', '401 invalid x-api-key', { status: 401 })
      }
      return ok('{"items":[]}')
    }

    const result = await executeWithRotation(() => promptFor(['only-id']), {
      pool,
      models: ['model-1'],
      transport,
      now: () => clock.now,
      sleep: async () => undefined,
      hooks: { onRetry: ({ keyId, kind }) => retries.push({ keyId, kind }) },
    })

    expect(result.keyId).toBe('key-b')
    expect(result.attempts).toBe(2)
    expect(pool.health('key-a', T0)).toBe('invalid')
    expect(pool.health('key-b', T0)).toBe('healthy')
    expect(retries).toEqual([{ keyId: 'key-a', kind: 'unauthorized' }])
  })

  it('a 403 marks the key invalid too', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5 })
    pool.setKeys([seed('key-a')])

    const transport: BatchTransport = async () => {
      throw new ProviderError('forbidden', '403 forbidden', { status: 403 })
    }

    const error = await captureError(
      executeWithRotation(() => promptFor(['only-id']), {
        pool,
        models: ['model-1'],
        transport,
        now: () => clock.now,
        sleep: async () => undefined,
      }),
    )

    expect(pool.health('key-a', T0)).toBe('invalid')
    if (!(error instanceof ProviderError)) throw new Error('expected a ProviderError')
    expect(error.kind).toBe('unauthorized')
  })

  it('a 403 walks the model chain before condemning the key', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5 })
    pool.setKeys([seed('key-a')])

    // OpenRouter 403s free models it gates to agentic harnesses while the key
    // itself is healthy — the run must fall through to the next model instead
    // of poisoning the only key (that bug killed a whole live run, Oct 2026).
    const transport: BatchTransport = async (input) => {
      if (input.model === 'model-gated') {
        throw new ProviderError('forbidden', '403 only available on agentic harnesses', {
          status: 403,
        })
      }
      return ok('{"items":[]}')
    }

    const fallbacks: string[] = []
    const result = await executeWithRotation(() => promptFor(['only-id']), {
      pool,
      models: ['model-gated', 'model-ok'],
      transport,
      now: () => clock.now,
      sleep: async () => undefined,
      hooks: { onModelFallback: (model) => fallbacks.push(model) },
    })

    expect(result.model).toBe('model-ok')
    expect(fallbacks).toEqual(['model-ok'])
    expect(pool.health('key-a', T0)).toBe('healthy')
  })

  it('all keys invalid → throws ProviderError(unauthorized) instead of waiting', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5 })
    pool.setKeys([seed('key-a')])

    let calls = 0
    const transport: BatchTransport = async () => {
      calls += 1
      throw new ProviderError('unauthorized', '401 invalid key', { status: 401 })
    }

    const error = await captureError(
      executeWithRotation(() => promptFor(['only-id']), {
        pool,
        models: ['model-1'],
        transport,
        now: () => clock.now,
        sleep: async () => undefined,
      }),
    )

    expect(calls).toBe(1)
    if (!(error instanceof ProviderError)) throw new Error('expected a ProviderError')
    expect(error.kind).toBe('unauthorized')
    expect(error.message).toBe('Every configured key was rejected')
  })
})

describe('model fallback chain', () => {
  it('advances the chain on model_missing and reports the new model', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5 })
    pool.setKeys([seed('key-a')])

    const fallbacks: string[] = []
    const transport: BatchTransport = async ({ model }) => {
      if (model === 'model-primary') {
        throw new ProviderError('model_missing', '404 model not found', { status: 404 })
      }
      return ok('{"items":[]}')
    }

    const result = await executeWithRotation(() => promptFor(['only-id']), {
      pool,
      models: ['model-primary', 'model-fallback'],
      transport,
      now: () => clock.now,
      sleep: async () => undefined,
      hooks: { onModelFallback: (model) => fallbacks.push(model) },
    })

    expect(result.model).toBe('model-fallback')
    expect(result.attempts).toBe(2)
    expect(fallbacks).toEqual(['model-fallback'])
  })

  it('an exhausted model chain fails with model_missing instead of burning quota forever', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5 })
    pool.setKeys([seed('key-a')])

    let calls = 0
    const transport: BatchTransport = async () => {
      calls += 1
      throw new ProviderError('model_missing', '404 model not found', { status: 404 })
    }

    const error = await captureError(
      executeWithRotation(() => promptFor(['only-id']), {
        pool,
        models: ['only-model'],
        transport,
        maxConsecutiveFailures: 3,
        now: () => clock.now,
        sleep: async () => undefined,
      }),
    )

    // One pass through the chain is enough: a known-missing model must not
    // be retried up to maxConsecutiveFailures.
    expect(calls).toBe(1)
    if (!(error instanceof ProviderError)) throw new Error('expected a ProviderError')
    expect(error.kind).toBe('model_missing')
  })
})

describe('permanent payload errors (context/output limit)', () => {
  it('a context-overflow 400 fails on the first attempt without condemning the key', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5 })
    pool.setKeys([seed('key-a'), seed('key-b')])

    let calls = 0
    const transport: BatchTransport = async () => {
      calls += 1
      throw new ProviderError('bad_request', '400: context_length_exceeded', { status: 400 })
    }

    const error = await captureError(
      executeWithRotation(() => promptFor(['only-id']), {
        pool,
        models: ['model-1'],
        transport,
        now: () => clock.now,
        sleep: async (ms) => {
          clock.now += ms
        },
      }),
    )

    // One attempt: a payload problem follows the request, not the key, so
    // neither rotating keys nor retrying the same body can succeed — retrying
    // it would burn quota on every key (PHASE-02 req. 7 + test matrix case).
    expect(calls).toBe(1)
    if (!(error instanceof ProviderError)) throw new Error('expected a ProviderError')
    expect(error.kind).toBe('bad_request')

    // It is a request failure, not a rate limit or a spent allowance, and the
    // key stays usable: the error must not falsely claim exhaustion.
    expect(error.message).toContain('context_length_exceeded')
    expect(pool.health('key-a', T0)).not.toBe('invalid')
    // Both keys remain usable — no cooldown, no invalidation, nothing that
    // would let this look like an exhausted pool.
    expect(pool.canPick(0, T0)).toBe(true)
    const reason = reasonFor(error).reasonCode
    expect(reason).not.toBe('ALL_KEYS_COOLING_DOWN')
    expect(reason).not.toBe('QUOTA_EXHAUSTED')
  })
})

describe('abort', () => {
  it('an already-aborted signal cancels before any provider call', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5 })
    pool.setKeys([seed('key-a')])

    let calls = 0
    const transport: BatchTransport = async () => {
      calls += 1
      return ok('{"items":[]}')
    }
    const controller = new AbortController()
    controller.abort()

    const error = await captureError(
      executeWithRotation(() => promptFor(['only-id']), {
        pool,
        models: ['model-1'],
        transport,
        signal: controller.signal,
        now: () => clock.now,
        sleep: async () => undefined,
      }),
    )

    expect(calls).toBe(0)
    if (!(error instanceof DOMException)) throw new Error('expected a DOMException')
    expect(error.name).toBe('AbortError')
  })

  it('aborting mid-flight cancels the in-flight call promptly', async () => {
    const clock = { now: T0 }
    const pool = new KeyPool({ now: () => clock.now, random: () => 0.5 })
    pool.setKeys([seed('key-a')])

    const transport: BatchTransport = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        })
      })

    const controller = new AbortController()
    const promise = executeWithRotation(() => promptFor(['only-id']), {
      pool,
      models: ['model-1'],
      transport,
      signal: controller.signal,
      now: () => clock.now,
      sleep: async () => undefined,
    })
    controller.abort()

    const error = await captureError(promise)
    if (!(error instanceof DOMException)) throw new Error('expected a DOMException')
    expect(error.name).toBe('AbortError')
  })

  it('defaultSleep resolves once the delay elapses and rejects when aborted', async () => {
    await expect(defaultSleep(0)).resolves.toBeUndefined()

    const controller = new AbortController()
    controller.abort()
    const error = await captureError(defaultSleep(60_000, controller.signal))
    if (!(error instanceof DOMException)) throw new Error('expected a DOMException')
    expect(error.name).toBe('AbortError')
  })
})

describe('WakeChannel', () => {
  it('fire() ends an in-flight sleep instead of waiting out the rate-limit window', async () => {
    const channel = new WakeChannel()
    const pending = channel.sleep(60_000)
    channel.fire()
    await expect(pending).resolves.toBeUndefined()
  })

  it('one fire() releases every sleep parked on the channel', async () => {
    const channel = new WakeChannel()
    const first = channel.sleep(60_000)
    const second = channel.sleep(60_000)
    channel.fire()
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
  })

  it('a fire is not sticky — a sleep started afterwards still serves its delay', async () => {
    const channel = new WakeChannel()
    channel.fire()
    const started = Date.now()
    await channel.sleep(40)
    // A leftover wake would resolve this near-instantly; it must not.
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
  })

  it('aborting still rejects with AbortError, so Cancel keeps working during a wait', async () => {
    const channel = new WakeChannel()
    const controller = new AbortController()
    const pending = channel.sleep(60_000, controller.signal)
    controller.abort()
    const error = await captureError(pending)
    if (!(error instanceof DOMException)) throw new Error('expected a DOMException')
    expect(error.name).toBe('AbortError')
  })

  it('an already-aborted signal rejects before registering a listener', async () => {
    const channel = new WakeChannel()
    const controller = new AbortController()
    controller.abort()
    const error = await captureError(channel.sleep(60_000, controller.signal))
    if (!(error instanceof DOMException)) throw new Error('expected a DOMException')
    expect(error.name).toBe('AbortError')
  })
})
