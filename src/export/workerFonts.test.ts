/**
 * Worker-side font registration (C-04 / L-03).
 *
 * The export worker's canvas shapes with whatever is in *its* FontFaceSet;
 * these tests pin the two halves of the fix: faces get loaded in when the
 * environment supports it, and a failure — including a whole environment
 * without `FontFace`, which is exactly what jsdom is — degrades to an issue
 * instead of an exception.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FontFaceInfo } from '@/fonts'
import {
  clearWorkerFontRegistration,
  fontRegistrationIssues,
  registerWorkerFonts,
  type FontScope,
} from './workerFonts'

const face = (overrides: Partial<FontFaceInfo> = {}): FontFaceInfo => ({
  family: 'Noto Sans Myanmar',
  weight: '400',
  style: 'normal',
  url: 'data:font/woff2;base64,AAAA',
  unicodeRange: 'U+1000-109F',
  ...overrides,
})

/** A scope that records what got constructed and added. */
function fakeScope(shouldFail: boolean | ((family: string) => boolean) = false) {
  const constructed: Array<{ family: string; source: string; descriptors: Record<string, string> }> =
    []
  const added: string[] = []
  class FakeFontFace {
    constructor(
      readonly family: string,
      readonly source: string,
      readonly descriptors: Record<string, string> = {},
    ) {
      constructed.push({ family, source, descriptors })
    }
    load(): Promise<unknown> {
      const fail = typeof shouldFail === 'function' ? shouldFail(this.family) : shouldFail
      return fail ? Promise.reject(new Error('FETCH_FAILED')) : Promise.resolve(this)
    }
  }
  const scope: FontScope = {
    FontFace: FakeFontFace,
    fonts: {
      add: (font) => {
        added.push((font as FakeFontFace).family)
      },
    },
  }
  return { scope, constructed, added }
}

beforeEach(() => {
  clearWorkerFontRegistration()
})

describe('registerWorkerFonts', () => {
  it('loads and adds every face, carrying weight, style and unicode-range', async () => {
    const { scope, constructed, added } = fakeScope()
    const result = await registerWorkerFonts([face()], scope)
    expect(result).toEqual({ registered: ['Noto Sans Myanmar'], failed: [] })
    expect(constructed[0].source).toBe('url("data:font/woff2;base64,AAAA")')
    expect(constructed[0].descriptors).toEqual({
      weight: '400',
      style: 'normal',
      unicodeRange: 'U+1000-109F',
    })
    expect(added).toEqual(['Noto Sans Myanmar'])
  })

  it('reports a face that will not load instead of throwing', async () => {
    const { scope } = fakeScope((family) => family === 'Noto Sans Myanmar')
    const result = await registerWorkerFonts([face(), face({ family: 'Padauk' })], scope)
    expect(result.failed).toEqual(['Noto Sans Myanmar'])
    expect(result.registered).toEqual(['Padauk'])
  })

  it('behaves the same in an environment with no FontFace at all (jsdom, old browsers)', async () => {
    const result = await registerWorkerFonts([face()], {} as never)
    expect(result).toEqual({ registered: [], failed: ['Noto Sans Myanmar'] })
  })

  it('does not register the same face twice across exports, but retries failures', async () => {
    const first = fakeScope()
    await registerWorkerFonts([face()], first.scope)
    expect(first.constructed).toHaveLength(1)

    // Second export, same session: the face is already on the thread.
    const second = fakeScope()
    await registerWorkerFonts([face()], second.scope)
    expect(second.constructed).toHaveLength(0)

    // A face that fails was never added, so the next build tries it again.
    const failing = fakeScope(true)
    await registerWorkerFonts([face({ family: 'Padauk' })], failing.scope)
    await registerWorkerFonts([face({ family: 'Padauk' })], failing.scope)
    expect(failing.constructed).toHaveLength(2)
  })

  it('handles an empty list without touching the scope', async () => {
    const { scope, constructed } = fakeScope()
    expect(await registerWorkerFonts([], scope)).toEqual({ registered: [], failed: [] })
    expect(constructed).toHaveLength(0)
  })

  it('does not explode when the scope has FontFace but no FontFaceSet', async () => {
    const { scope } = fakeScope()
    const bare: FontScope = { FontFace: scope.FontFace }
    const result = await registerWorkerFonts([face()], bare)
    expect(result.failed).toEqual(['Noto Sans Myanmar'])
  })
})

describe('fontRegistrationIssues', () => {
  it('is silent when nothing failed', () => {
    expect(
      fontRegistrationIssues({ registered: ['A'], failed: [] }, { usedFamilies: [], hasMyanmar: false }),
    ).toEqual([])
  })

  it('always reports a failed family some block names', () => {
    const issues = fontRegistrationIssues(
      { registered: [], failed: ['Calibri'] },
      { usedFamilies: ['Calibri'], hasMyanmar: false },
    )
    expect(issues).toHaveLength(1)
    expect(issues[0].code).toBe('EXPORT_FONT_MISSING')
    expect(issues[0].fonts).toEqual(['Calibri'])
    expect(issues[0].detail).toContain('Calibri')
  })

  it('reports a failed stack family when the document has Myanmar text', () => {
    const issues = fontRegistrationIssues(
      { registered: [], failed: ['Padauk'] },
      { usedFamilies: ['Calibri'], hasMyanmar: true },
    )
    expect(issues[0].fonts).toEqual(['Padauk'])
  })

  it('stays quiet about an unused stack family on a Latin-only document', () => {
    expect(
      fontRegistrationIssues(
        { registered: [], failed: ['Padauk'] },
        { usedFamilies: ['Calibri'], hasMyanmar: false },
      ),
    ).toEqual([])
  })

  it('matches family names case-insensitively', () => {
    const issues = fontRegistrationIssues(
      { registered: [], failed: ['calibri'] },
      { usedFamilies: ['Calibri'], hasMyanmar: false },
    )
    expect(issues).toHaveLength(1)
  })

  it('never throws on odd input', () => {
    const spy = vi.fn()
    try {
      fontRegistrationIssues({ registered: [], failed: [] }, { usedFamilies: [], hasMyanmar: false })
      spy()
    } catch {
      /* must not happen */
    }
    expect(spy).toHaveBeenCalled()
  })
})
