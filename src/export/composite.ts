/**
 * Raster page composition (Phase 4).
 *
 * Turns one page of the export document into a single image: the rendered
 * page *background* (figures, rules, watermarks — the analysis worker erased
 * the original text for us) with the translated text painted on top using the
 * same wrap/auto-fit rules as the HTML output. This is what makes the raster
 * PDF and the PNG/JPG pack show the translation rather than the original.
 *
 * Runs inside the export worker on an `OffscreenCanvas`: the main thread never
 * sees a pixel, so a 300-page raster export still keeps the UI responsive.
 */

import { createCanvasMeasurer, fitBlockText, type TextMeasurer } from '@/editor/autofit'
import { reflowBlocks } from './reflow'
import { listPrefix, pageBlocks, fontStackFor } from './shared'
import type { ExportBlock, ExportPage } from './types'

export interface CompositeOptions {
  /** Pixels per PDF point (2 = 144 dpi). */
  scale: number
  /** Extra font families appended after each block's own family. */
  fontStack: string
  /** Output type (`image/jpeg` also takes a 0..1 `quality`). */
  type?: 'image/png' | 'image/jpeg'
  quality?: number
  /**
   * Push down what auto-fit could not clear (see `ExportOptions.adjustLayout`).
   * Off keeps every block at the `y` the PDF gave it.
   */
  adjustLayout?: boolean
  /** Called once per block the page edge stopped (only while reflowing). */
  onOverlap?: (blockId: string) => void
  /**
   * Called once per block whose extra lines were cut at the box edge — only
   * while `adjustLayout` is off, which is the only mode where the paint
   * clamps at all (the default sheet may not print past its own geometry,
   * and silence about that was the bug — C-03).
   */
  onClipped?: (blockId: string) => void
  /** Called when no canvas was available to measure text with. */
  onEstimated?: () => void
}

/** Canvas measuring context for a worker thread (no DOM available there). */
export function workerMeasurer(onFallback?: () => void): TextMeasurer {
  return createCanvasMeasurer(() => {
    if (typeof OffscreenCanvas === 'undefined') return null
    return new OffscreenCanvas(1, 1).getContext('2d')
  }, onFallback)
}

function alignmentOf(block: ExportBlock): CanvasTextAlign {
  if (block.alignment === 'center') return 'center'
  if (block.alignment === 'right') return 'right'
  return 'left'
}

function textOf(block: ExportBlock): string {
  if (block.translatedText.trim().length > 0) return block.translatedText
  return block.sourceText
}

/** Paints one block (wrap → auto-fit → one `fillText` per line). */
function drawBlock(
  ctx: OffscreenCanvasRenderingContext2D,
  block: ExportBlock,
  options: CompositeOptions,
  measure: TextMeasurer,
): void {
  const text = textOf(block)
  if (text.trim().length === 0) return

  const font = {
    fontFamily: block.fontFamily,
    bold: block.bold,
    italic: block.italic,
  }
  const fitted = fitBlockText({
    text,
    box: { width: block.width, height: block.height },
    ...font,
    originalSize: block.fontSize,
    lineHeight: block.lineHeight,
    measure,
  })

  const scale = options.scale
  const size = fitted.fontSize
  const family = fontStackFor(block, { fontStack: options.fontStack })
  ctx.font = `${font.italic ? 'italic ' : ''}${font.bold ? '700 ' : '400 '}${size * scale}px ${family}`
  ctx.fillStyle = /^#[0-9a-f]{3,8}$/i.test(block.color) ? block.color : '#000000'
  ctx.direction = block.direction === 'rtl' ? 'rtl' : 'ltr'
  ctx.textAlign = alignmentOf(block)
  ctx.textBaseline = 'top'

  const anchorX = (): number => {
    const align = alignmentOf(block)
    if (align === 'center') return (block.x + block.width / 2) * scale
    if (align === 'right') return (block.x + block.width) * scale
    return block.x * scale
  }

  const lines = fitted.lines.length > 0 ? fitted.lines : [text]
  const step = size * block.lineHeight * scale
  const x = anchorX()

  // Source geometry — the default sheet — prints *inside* the box and nothing
  // else: a line the 6pt floor could not bring back is cut here and reported
  // through `onClipped`, rather than painted over whatever sits below (C-03).
  // Auto-fit has already shrunk a fitting block until its own line bottoms
  // land inside the box, so the clamp only ever fires on text that genuinely
  // does not fit. With `adjustLayout` on there is no clamp: the reflow has
  // made room for every line, and cutting here would delete exactly the text
  // the push was for.
  //
  // The one thing the clamp may never do is paint *zero* lines. A box stored
  // at its glyph height (a running header/footer sits at h = 9pt) is shorter
  // than one line advance at the floor — 6 × 1.7 = 10.2pt — so the naive test
  // failed for `index = 0` too and the whole block vanished from the sheet
  // while the HTML export printed it. Losing the block is the worse failure:
  // the first line always lands, past the box if that is the only place it
  // fits, and only the lines after it are cut.
  const clamp = options.adjustLayout !== true
  const boxBottom = (block.y + block.height) * scale
  let dropped = false
  let painted = 0

  lines.forEach((line, index) => {
    const value = index === 0 ? `${listPrefix(block, line)}${line}` : line
    if (value.length === 0) return
    if (clamp && painted > 0 && block.y * scale + (index + 1) * step > boxBottom + 1) {
      dropped = true
      return
    }
    ctx.fillText(value, x, block.y * scale + index * step)
    painted += 1
  })

  // `!fitted.fits` covers what the line loop cannot see: a line wider than
  // the box (an unbreakable token) paints past the right edge, and a height
  // that only just exceeds the box can round into place.
  if (clamp && (dropped || !fitted.fits)) options.onClipped?.(block.id)

  // The same red flag the HTML export draws (`.block.overflow`, print mode
  // included): the model already knows this block's text outgrew its source
  // box, and the image export must say so too rather than look pristine.
  // Painting the flag is what "honour `block.overflow`" means here — the
  // *count* in `EXPORT_LAYOUT_CLIPPED` stays the worker's own measurement.
  if (block.overflow) {
    ctx.setLineDash([4 * scale, 3 * scale])
    ctx.strokeStyle = '#dc2626'
    ctx.lineWidth = Math.max(1, scale)
    ctx.strokeRect(block.x * scale, block.y * scale, block.width * scale, block.height * scale)
    ctx.setLineDash([])
  }
}

/**
 * The blocks `compositePage` will paint, in painting order.
 *
 * With `adjustLayout` off — the default — this is the page exactly as
 * extracted: every block at the `y` the PDF gave it, which is the promise an
 * image export makes. On, the page runs the same push-down the HTML and print
 * exports use, measured against what the paint will actually use: auto-fit has
 * already shrunk each block into its box, so a translation that fits after
 * shrinking leaves its neighbours exactly where they were, and only text that
 * still overflows at the 6pt floor spends a push. The list marker travels with
 * the text for the reason `printedLine` carries it in the HTML path — a bullet
 * that pushes the first word onto a second line has to be counted too.
 */
export function layoutBlocks(
  page: ExportPage,
  options: CompositeOptions,
  measure: TextMeasurer,
): ExportBlock[] {
  const blocks = pageBlocks(page)
  if (options.adjustLayout !== true) return blocks
  try {
    const painted = blocks.map((block) => {
      const text = textOf(block)
      if (text.trim().length === 0) return block
      const fitted = fitBlockText({
        text,
        box: { width: block.width, height: block.height },
        fontFamily: block.fontFamily,
        bold: block.bold,
        italic: block.italic,
        originalSize: block.fontSize,
        lineHeight: block.lineHeight,
        measure,
      })
      return fitted.fontSize === block.fontSize ? block : { ...block, fontSize: fitted.fontSize }
    })

    const onOverlap = options.onOverlap
    return reflowBlocks(painted, {
      measure,
      pageHeight: page.height,
      textOf: (block) => {
        const text = textOf(block)
        return `${listPrefix(block, text)}${text}`
      },
      onOverlap: onOverlap ? (block) => onOverlap(block.id) : undefined,
    })
  } catch {
    // Adjusting the layout is something the reader opted into, not the export
    // itself: a pass that cannot finish leaves the page at source geometry —
    // where this option starts anyway — rather than failing the whole sheet,
    // the same bargain `drawBlock` makes for a single unrenderable block.
    return blocks
  }
}

/**
 * Composites one page. `background` may be null (blank sheet with text) — the
 * callers treat a failed background render as "no artwork", never as a
 * reason to drop the text.
 */
export async function compositePage(
  page: ExportPage,
  background: Blob | null,
  options: CompositeOptions,
): Promise<Blob> {
  const scale = Math.max(0.5, options.scale)
  const width = Math.max(1, Math.round(page.width * scale))
  const height = Math.max(1, Math.round(page.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('COMPOSITE_NO_CONTEXT')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)

  if (background) {
    try {
      const bitmap = await createImageBitmap(background)
      ctx.drawImage(bitmap, 0, 0, width, height)
      bitmap.close?.()
    } catch {
      /* keep the white sheet */
    }
  }

  // One measurer for both jobs: it decides where a block is painted and, when
  // the caller asked for layout adjustment, where reflow puts it.
  const measure = workerMeasurer(options.onEstimated)
  for (const block of layoutBlocks(page, options, measure)) {
    try {
      drawBlock(ctx, block, options, measure)
    } catch {
      /* a single unrenderable block must not fail the whole page */
    }
  }

  return canvas.convertToBlob(
    options.type === 'image/jpeg'
      ? { type: 'image/jpeg', quality: options.quality ?? 0.85 }
      : { type: 'image/png' },
  )
}
