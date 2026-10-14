/**
 * Page-growth acceptance: what the absolute export does with text that will
 * not fit the source page even after auto-fit. Written against the same
 * deterministic measurer reflow uses — 'word ' is 30pt at 12pt, so a 468pt
 * column holds fifteen words a line and a 220pt column holds seven — so every
 * sheet break below can be checked by hand.
 */
import { describe, expect, it } from 'vitest'
import type { TextMeasurer } from '@/editor/autofit'
import { paginateBlocks, type PaginateOptions } from './pagination'
import type { ExportBlock } from './types'

/** ~0.5 em average advance — deterministic, no canvas needed. */
const measure: TextMeasurer = ({ text, fontSize }) => text.length * fontSize * 0.5

const LINE = 19.2 // 12pt × 1.6
const PAGE = 200

/** `n` space-separated words; a 468pt column wraps every fifteen, a 220pt every seven. */
function words(n: number): string {
  return Array.from({ length: n }, () => 'word').join(' ')
}

function block(overrides: Partial<ExportBlock> = {}): ExportBlock {
  return {
    id: 'blk_1',
    order: 0,
    kind: 'paragraph',
    region: 'body',
    status: 'translated',
    alignment: 'left',
    x: 72,
    y: 72,
    width: 468,
    height: LINE,
    fontFamily: 'Noto Sans',
    fontSize: 12,
    lineHeight: 1.6,
    color: '#111827',
    bold: false,
    italic: false,
    listMarker: null,
    headingLevel: null,
    links: [],
    figures: [],
    tableCells: null,
    tableSpans: null,
    sourceText: 'Source text',
    translatedText: words(4),
    characterCount: 11,
    skipRule: null,
    placeholders: [],
    direction: 'ltr',
    fittedFontSize: null,
    overflow: false,
    hasSuggestion: false,
    ...overrides,
  }
}

function options(overrides: Partial<PaginateOptions<ExportBlock>> = {}): PaginateOptions<ExportBlock> {
  return { measure, pageHeight: PAGE, textOf: (b) => b.translatedText, ...overrides }
}

function at(sheets: ExportBlock[][], id: string): { sheet: number; block: ExportBlock } {
  for (const [sheet, blocks] of sheets.entries()) {
    const found = blocks.find((b) => b.id === id)
    if (found) return { sheet, block: found }
  }
  throw new Error(`no block ${id}`)
}

describe('paginateBlocks', () => {
  it('returns one sheet and the same objects when everything still fits', () => {
    const a = block({ id: 'a' })
    const b = block({ id: 'b', y: 95 })
    const sheets = paginateBlocks([a, b], options())
    expect(sheets).toHaveLength(1)
    expect(sheets[0]).toEqual([a, b])
    expect(sheets[0][0]).toBe(a)
    expect(sheets[0][1]).toBe(b)
  })

  it('grows a second sheet for a block that would run past the bottom', () => {
    // a fits at the top; b sits near the 200pt edge and needs two lines (38.4),
    // so 170 + 38.4 = 208.4 overflows and it moves to a fresh sheet.
    const a = block({ id: 'a', translatedText: words(15) })
    const b = block({ id: 'b', y: 170, translatedText: words(20) })
    const sheets = paginateBlocks([a, b], options())
    expect(sheets).toHaveLength(2)
    expect(at(sheets, 'a')).toEqual({ sheet: 0, block: expect.objectContaining({ y: 72 }) })
    const moved = at(sheets, 'b')
    expect(moved.sheet).toBe(1)
    expect(moved.block.y).toBe(72) // top of the continuation sheet
    expect(moved.block.x).toBe(72) // keeps its column
  })

  it('keeps the block objects whose y never moved', () => {
    const a = block({ id: 'a', translatedText: words(15) })
    const b = block({ id: 'b', y: 170, translatedText: words(20) })
    const sheets = paginateBlocks([a, b], options())
    expect(sheets[0][0]).toBe(a)
    expect(sheets[1][0]).not.toBe(b) // b moved, so it is a fresh object
  })

  it('chains several blocks onto one continuation sheet before growing another', () => {
    // Three two-line blocks (38.4 each) stacked from y=72: sheet 0 holds
    // 72→110.4→(148.8 would end 187.2, fits) then the fourth overflows.
    const a = block({ id: 'a', y: 72, translatedText: words(20) })
    const b = block({ id: 'b', y: 110, translatedText: words(20) })
    const c = block({ id: 'c', y: 148, translatedText: words(20) })
    const d = block({ id: 'd', y: 186, translatedText: words(20) })
    const sheets = paginateBlocks([a, b, c, d], options())
    expect(sheets).toHaveLength(2)
    expect(at(sheets, 'a').sheet).toBe(0)
    expect(at(sheets, 'b').sheet).toBe(0)
    // c: 148 + 38.4 = 186.4 fits; d: pushed to 186.4 → 224.8 overflows.
    expect(at(sheets, 'c').sheet).toBe(0)
    expect(at(sheets, 'd').sheet).toBe(1)
  })

  it('lets each column of a two-column page grow on its own', () => {
    // Left column overflows (a3 needs 57.6 near the edge); the right column,
    // which never overflows, must stay on the first sheet untouched.
    const left = [
      block({ id: 'a1', order: 0, x: 72, width: 220, y: 72, translatedText: words(7) }),
      block({ id: 'a2', order: 1, x: 72, width: 220, y: 95, translatedText: words(7) }),
      block({ id: 'a3', order: 2, x: 72, width: 220, y: 180, translatedText: words(20) }),
    ]
    const right = [
      block({ id: 'b1', order: 3, x: 320, width: 220, y: 72, translatedText: words(7) }),
      block({ id: 'b2', order: 4, x: 320, width: 220, y: 95, translatedText: words(7) }),
    ]
    const sheets = paginateBlocks([...left, ...right], options())
    expect(sheets).toHaveLength(2)
    expect(at(sheets, 'a1').sheet).toBe(0)
    expect(at(sheets, 'a2').sheet).toBe(0)
    expect(at(sheets, 'a3').sheet).toBe(1) // left column grew
    expect(at(sheets, 'b1').sheet).toBe(0) // right column did not
    expect(at(sheets, 'b2').sheet).toBe(0)
    expect(at(sheets, 'b1').block.x).toBe(320)
  })

  it('realigns both columns beneath a full-width band', () => {
    const title = block({ id: 'title', order: 0, y: 72, width: 468, translatedText: words(15) })
    const left = block({ id: 'left', order: 1, x: 72, width: 220, y: 110, translatedText: words(20) })
    const right = block({ id: 'right', order: 2, x: 320, width: 220, y: 110, translatedText: words(7) })
    const sheets = paginateBlocks([title, left, right], options())
    expect(sheets).toHaveLength(1)
    expect(at(sheets, 'title').block.y).toBe(72)
    // Both columns restart directly beneath the title (72 + 19.2 = 91.2).
    expect(at(sheets, 'left').block.y).toBeCloseTo(91.2)
    expect(at(sheets, 'right').block.y).toBeCloseTo(91.2)
  })

  it('grows a sheet when a band and the column under it outlast the page', () => {
    // A tall-but-fitting left column ends at 187.2pt; the mid-page band then
    // has no room on sheet 0, so it — and the right column that realigns
    // beneath it — move to a second sheet.
    const title = block({ id: 'title', order: 0, y: 72, width: 468, translatedText: words(15) })
    const left = block({ id: 'left', order: 1, x: 72, width: 220, y: 110, translatedText: words(30) })
    const band = block({ id: 'band', order: 2, y: 190, width: 468, translatedText: words(15) })
    const right = block({ id: 'right', order: 3, x: 320, width: 220, y: 110, translatedText: words(7) })
    const sheets = paginateBlocks([title, left, band, right], options())
    expect(at(sheets, 'title').sheet).toBe(0)
    expect(at(sheets, 'left').sheet).toBe(0) // 91.2 + 96 = 187.2, still on sheet 0
    expect(at(sheets, 'band').sheet).toBe(1) // 187.2 + 19.2 overflows, band grows a sheet
    expect(at(sheets, 'right').sheet).toBe(1) // realigned under the band
    expect(at(sheets, 'right').block.x).toBe(320)
  })

  it('reports only a block taller than a whole sheet', () => {
    const a = block({ id: 'a', y: 72, translatedText: words(15) })
    const giant = block({ id: 'giant', y: 170, translatedText: words(160) }) // 11 lines ≈ 211pt > 200
    const over: string[] = []
    const sheets = paginateBlocks([a, giant], options({ onOverflow: (b) => over.push(b.id) }))
    expect(over).toEqual(['giant'])
    expect(at(sheets, 'giant').sheet).toBe(1)
  })

  it('reports nothing when growth alone clears every block', () => {
    const a = block({ id: 'a', translatedText: words(15) })
    const b = block({ id: 'b', y: 170, translatedText: words(20) })
    const over: string[] = []
    paginateBlocks([a, b], options({ onOverflow: (blk) => over.push(blk.id) }))
    expect(over).toEqual([])
  })

  it('measures the text the builder will actually print', () => {
    const a = block({ id: 'a', translatedText: words(4) })
    const b = block({ id: 'b', y: 170, translatedText: words(4) })
    const sheets = paginateBlocks([a, b], options({ textOf: () => words(20) }))
    expect(sheets).toHaveLength(2)
  })

  it('grows a single page one sheet at a time when the text is very long', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      block({ id: `b${i}`, y: 72 + i * 38, translatedText: words(20) }),
    )
    const sheets = paginateBlocks(many, options())
    expect(sheets.length).toBeGreaterThan(2)
    // Every block lands on exactly one sheet, none dropped.
    const seen = sheets.flat().map((b) => b.id)
    expect(new Set(seen).size).toBe(12)
  })

  it('returns a single sheet when there is no page to overflow', () => {
    const a = block({ id: 'a', y: 760, translatedText: words(20) })
    const sheets = paginateBlocks([a], options({ pageHeight: 0 }))
    expect(sheets).toEqual([[a]])
  })

  it('treats an all-wide page as one column, not a band plus phantom columns', () => {
    // Every block is 468pt wide (full width), so nothing "spans" anything and
    // the page is a single vertical flow.
    const a = block({ id: 'a', y: 72, translatedText: words(15) })
    const b = block({ id: 'b', y: 170, translatedText: words(20) })
    const sheets = paginateBlocks([a, b], options())
    expect(sheets).toHaveLength(2)
    expect(at(sheets, 'b').sheet).toBe(1)
  })
})
