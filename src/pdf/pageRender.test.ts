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
  eraseSignature,
  planErase,
  storedEraseBoxes,
  type ErasableBlock,
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
