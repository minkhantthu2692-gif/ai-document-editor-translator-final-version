/**
 * Erasure planning for background renders (C-02 / L-01).
 *
 * `renderPage` itself needs an `OffscreenCanvas` and a real pdf.js page, so
 * what is pinned here is the decision it makes *before* it paints: which
 * rectangles get masked when a page's text is in the image rather than in a
 * text layer. The canvas half of this path is verified visually in Phase 03's
 * rendered-page pass.
 */

import { describe, expect, it } from 'vitest'
import {
  blendAt,
  blendCorners,
  eraseSignature,
  medianColor,
  planErase,
  resolveRingSides,
  runExtent,
  storedEraseBoxes,
  type ErasableBlock,
  type RingSides,
} from './pageRender'
import type { BBox } from './stableId'

describe('planErase', () => {
  it('masks every text-layer run when there is no stored geometry', () => {
    const runs = [{ x: 10, y: 20, w: 100, h: 12 }]
    expect(planErase(runs, undefined, 2)).toEqual(runs)
    expect(planErase(runs, [], 2)).toEqual(runs)
  })

  it('erases stored boxes on a page with no text layer (scanned/OCR)', () => {
    // `getTextContent()` on an image-only page yields no runs at all, so the
    // stored block boxes are the only geometry — scaled PDF points → pixels.
    const stored: BBox[] = [{ x: 72, y: 100, w: 300, h: 14 }]
    expect(planErase([], stored, 2)).toEqual([{ x: 144, y: 200, w: 600, h: 28 }])
  })

  it('skips a stored block the text layer already covers', () => {
    // A text block's padded box on a hybrid page: its run sits inside it, so
    // the runs erase it — repainting the padded box too would only widen the
    // mask over art (rules, bullets) the runs spared.
    const runs = [{ x: 100, y: 100, w: 50, h: 12 }]
    const stored: BBox[] = [{ x: 96, y: 96, w: 60, h: 20 }]
    expect(planErase(runs, stored, 1)).toEqual(runs)
  })

  it('still erases an OCR region no run touches (hybrid page)', () => {
    const runs = [{ x: 100, y: 100, w: 50, h: 12 }]
    const ocrRegion: BBox = { x: 300, y: 400, w: 200, h: 40 }
    const stored: BBox[] = [{ x: 96, y: 96, w: 60, h: 20 }, ocrRegion]
    expect(planErase(runs, stored, 1)).toEqual([runs[0], { x: 300, y: 400, w: 200, h: 40 }])
  })

  it('drops degenerate stored boxes instead of painting nothing-sized masks', () => {
    expect(planErase([], [{ x: 0, y: 0, w: 0, h: 10 }], 1)).toEqual([])
    expect(planErase([], [{ x: 0, y: 0, w: 10, h: -2 }], 1)).toEqual([])
  })

  it('keeps a page with nothing to mask empty', () => {
    expect(planErase([], [], 2)).toEqual([])
  })
})

describe('eraseSignature', () => {
  it('is empty without boxes, so an ordinary render keeps its old key', () => {
    expect(eraseSignature(undefined)).toBe('')
    expect(eraseSignature([])).toBe('')
  })

  it('separates different box sets', () => {
    const plain = eraseSignature([{ x: 0, y: 0, w: 10, h: 10 }])
    const other = eraseSignature([{ x: 0, y: 0, w: 10, h: 11 }])
    expect(plain).toBe('1:20')
    expect(other).not.toBe(plain)
  })
})

describe('storedEraseBoxes', () => {
  const block = (overrides: Partial<ErasableBlock> = {}): ErasableBlock => ({
    x: 72,
    y: 100,
    width: 300,
    height: 14,
    sourceText: 'Source line',
    translatedText: 'မြန်မာစာ',
    ...overrides,
  })

  it('gives image-only pages their block geometry', () => {
    expect(storedEraseBoxes('scanned', [block()])).toEqual([{ x: 72, y: 100, w: 300, h: 14 }])
    expect(storedEraseBoxes('mixed', [block()])).toHaveLength(1)
  })

  it('leaves text-layer pages alone: their runs are the erase geometry', () => {
    expect(storedEraseBoxes('text', [block()])).toEqual([])
    expect(storedEraseBoxes('complex', [block()])).toEqual([])
    expect(storedEraseBoxes('empty', [])).toEqual([])
  })

  it('skips blocks nothing will paint over, keeps source-fallback ones', () => {
    const blank = block({ translatedText: '   ', sourceText: '' })
    const pending = block({ translatedText: '', sourceText: 'Not yet translated' })
    expect(storedEraseBoxes('scanned', [blank])).toEqual([])
    expect(storedEraseBoxes('scanned', [pending])).toHaveLength(1)
  })

  it('skips degenerate geometry', () => {
    expect(storedEraseBoxes('scanned', [block({ width: 0 })])).toEqual([])
    expect(storedEraseBoxes('scanned', [block({ height: -3 })])).toEqual([])
  })
})

describe('ring repaint colour (L-07)', () => {
  const samples = (values: number[]): { r: number[]; g: number[]; b: number[] } => ({
    r: [...values],
    g: [...values],
    b: [...values],
  })

  it('medianColor takes the median of each channel and passes on no samples', () => {
    // (existing median() of an even list picks the upper-middle element)
    expect(medianColor(samples([10, 12, 14, 99]))).toEqual([14, 14, 14])
    expect(medianColor(samples([]))).toBeNull()
    expect(medianColor({ r: [200], g: [100], b: [50] })).toEqual([200, 100, 50])
  })

  it('resolveRingSides passes a full ring through untouched', () => {
    const sides = resolveRingSides({
      top: [255, 255, 255],
      bottom: [255, 255, 255],
      left: [255, 255, 255],
      right: [255, 255, 255],
    })
    expect(sides?.top).toEqual([255, 255, 255])
  })

  it('resolveRingSides substitutes the mean for a side a canvas-edge box could not sample', () => {
    const sides = resolveRingSides({
      top: null,
      bottom: [100, 100, 100],
      left: [200, 200, 200],
      right: [255, 200, 200],
    })
    expect(sides?.bottom).toEqual([100, 100, 100])
    // Per-channel mean of the three sides that did sample:
    expect(sides?.top).toEqual([185, 167, 167])
  })

  it('resolveRingSides reports nothing when no side sampled anything', () => {
    expect(
      resolveRingSides({ top: null, bottom: null, left: null, right: null }),
    ).toBeNull()
  })

  it('a uniform ring blends to one colour everywhere — the old flat fill', () => {
    const corners = blendCorners({
      top: [18, 18, 18],
      bottom: [18, 18, 18],
      left: [18, 18, 18],
      right: [18, 18, 18],
    })
    expect(corners.tl).toEqual([18, 18, 18])
    expect(blendAt(corners, 0.5, 0.5)).toEqual([18, 18, 18])
    expect(blendAt(corners, 0, 0)).toEqual([18, 18, 18])
    expect(blendAt(corners, 1, 0.3)).toEqual([18, 18, 18])
  })

  it('a varying ring starts each edge at that edge’s own median', () => {
    // Vertical gradient: white paper above, a dark figure below.
    const sides: RingSides = {
      top: [255, 255, 255],
      bottom: [0, 0, 0],
      left: [0, 0, 0],
      right: [0, 0, 0],
    }
    const corners = blendCorners(sides)
    expect(blendAt(corners, 0, 0)).toEqual([128, 128, 128]) // top edge: (top+left)/2
    expect(blendAt(corners, 1, 1)).toEqual([0, 0, 0]) // bottom-right corner: (bottom+right)/2
    expect(blendAt(corners, 0.5, 0.5)).toEqual([64, 64, 64]) // centre of the sweep
  })

  it('clamps coordinates outside the box instead of extrapolating', () => {
    const corners = blendCorners({
      top: [255, 255, 255],
      bottom: [0, 0, 0],
      left: [0, 0, 0],
      right: [0, 0, 0],
    })
    expect(blendAt(corners, -5, -5)).toEqual(blendAt(corners, 0, 0))
    expect(blendAt(corners, 9, 9)).toEqual(blendAt(corners, 1, 1))
  })

  it('sweeps monotonically from top to bottom across the box', () => {
    const corners = blendCorners({
      top: [255, 255, 255],
      bottom: [10, 10, 10],
      left: [255, 255, 255],
      right: [10, 10, 10],
    })
    const down = [0, 0.25, 0.5, 0.75, 1].map((v) => blendAt(corners, 0.5, v)[0])
    for (let i = 1; i < down.length; i++) expect(down[i]).toBeLessThan(down[i - 1])
  })
})

describe('runExtent (L-10)', () => {
  it('keeps a run whose reported width is real', () => {
    expect(runExtent('word', 11, 24)).toBe(24)
    expect(runExtent('word', 11, 0.6)).toBe(0.6)
  })

  it('estimates a degenerate run from its glyphs instead of skipping it', () => {
    expect(runExtent('.', 10, 0)).toBe(7.5)
    expect(runExtent('…', 10, 0.2)).toBe(7.5)
    expect(runExtent('several glyphs', 10, 0)).toBe(105)
  })

  it('never returns a width the caller would skip for visible text', () => {
    for (const [text, size] of [
      ['.', 1],
      ['i', 1],
      ['x', 2],
    ] as const) {
      expect(runExtent(text, size, 0)).toBeGreaterThanOrEqual(0.5)
    }
  })
})
