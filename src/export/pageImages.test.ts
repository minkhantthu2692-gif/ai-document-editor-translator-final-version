/**
 * Which pages hand stored block boxes to the background render (C-02 / L-01).
 *
 * The policy lives in one pure function so the per-`contentClass` decision is
 * pinned without a worker, a DOM or a PDF: scanned/mixed pages need their OCR
 * geometry erased or the overlay prints a second copy of the original text;
 * text pages must not, because a padded block box would repaint art the exact
 * text-layer runs spared.
 */

import { describe, expect, it } from 'vitest'
import { pageEraseBoxes } from './pageImages'
import type { ExportBlock, ExportPage } from './types'

function block(overrides: Partial<ExportBlock> = {}): ExportBlock {
  return {
    id: 'blk_1',
    order: 0,
    kind: 'paragraph',
    region: 'body',
    status: 'translated',
    alignment: 'left',
    x: 72,
    y: 100,
    width: 300,
    height: 14,
    fontFamily: 'Noto Sans',
    fontSize: 11,
    lineHeight: 1.7,
    color: '#111827',
    bold: false,
    italic: false,
    listMarker: null,
    headingLevel: null,
    links: [],
    figures: [],
    tableCells: null,
    tableSpans: null,
    sourceText: 'Source line',
    translatedText: 'မြန်မာစာ',
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

function page(contentClass: ExportPage['contentClass'], blocks: ExportBlock[]): ExportPage {
  return { index: 0, width: 612, height: 792, rotation: 0, contentClass, blocks }
}

describe('pageEraseBoxes', () => {
  it('gives scanned pages their block geometry — the text layer there is empty', () => {
    expect(pageEraseBoxes(page('scanned', [block()]))).toEqual([
      { x: 72, y: 100, w: 300, h: 14 },
    ])
  })

  it('gives mixed pages their blocks too — the render-side filter keeps only the OCR regions', () => {
    expect(pageEraseBoxes(page('mixed', [block(), block({ id: 'blk_2', y: 400 })]))).toHaveLength(
      2,
    )
  })

  it('leaves text-layer pages alone: their runs are the erase geometry', () => {
    expect(pageEraseBoxes(page('text', [block()]))).toEqual([])
    expect(pageEraseBoxes(page('complex', [block()]))).toEqual([])
    expect(pageEraseBoxes(page('empty', []))).toEqual([])
  })

  it('skips blocks nothing will paint over — their pixels must stay', () => {
    const blank = block({ translatedText: '   ', sourceText: '' })
    expect(pageEraseBoxes(page('scanned', [blank]))).toEqual([])
  })

  it('still erases source-fallback blocks (untranslated, but printed verbatim)', () => {
    const pending = block({ translatedText: '', sourceText: 'Not yet translated' })
    expect(pageEraseBoxes(page('scanned', [pending]))).toHaveLength(1)
  })

  it('skips degenerate geometry', () => {
    expect(pageEraseBoxes(page('scanned', [block({ width: 0 })]))).toEqual([])
    expect(pageEraseBoxes(undefined)).toEqual([])
  })
})
