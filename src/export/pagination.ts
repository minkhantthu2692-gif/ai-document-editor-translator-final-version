/**
 * Page growth for the absolutely-positioned export (and, later, the canvas).
 *
 * The reflow pass (`reflow.ts`) makes room for a longer translation by pushing
 * a block's neighbours down, but the page box is fixed: a block that will not
 * fit even after auto-fit has shrunk it to the 6pt floor is parked at the
 * bottom edge and reported as clipped. That is the right answer for an image
 * export, whose promise is source geometry — and the wrong one for a document
 * the reader will actually read, where the correct thing is simply to let the
 * text run onto the next page.
 *
 * This pass turns one source page's blocks into one or more vertical **sheets**
 * of the same width and height. Sheet 0 is the original page (a document whose
 * text all still fits comes back as exactly one sheet, byte-identical); every
 * block that would run past the bottom starts a fresh sheet at the top instead
 * of clamping. Page count may therefore grow, which is the intended trade: an
 * 8-page original can legitimately translate into 10.
 *
 * Three rules keep the growth honest about the page it is growing:
 *
 *  - **Columns flow independently.** A two-column page keeps its two columns
 *    side by side; each column packs its own blocks down its own stack and
 *    breaks to a new sheet when *it* runs out, so a longer left column does
 *    not drag the right one down with it. Blocks arrive in reading order
 *    (columns already ordered left-to-right within a zone), so a column is
 *    recovered by clustering on horizontal overlap.
 *  - **A full-width band realigns everything under it.** A title or rule that
 *    spans the gutter is placed below the deepest column, and every column
 *    restarts beneath it — so the reading order a spanning heading imposes is
 *    preserved across the break rather than two columns racing past it.
 *  - **Nothing is dropped, resized or re-measured.** Each block keeps its own
 *    `x`, its column, its font and its required height; only `y` and the sheet
 *    it lands on change. The vertical room a block needs is the same
 *    `blockPrintHeight` reflow measures, so the two passes cannot disagree.
 *
 * A block genuinely taller than a whole sheet cannot be placed without overlap;
 * it is laid at the top of a fresh sheet and reported through `onOverflow`, the
 * one case where clipping is unavoidable.
 */

import type { TextMeasurer } from '@/editor/autofit'
import { blockPrintHeight, type ReflowBlock } from './reflow'

/** Wider than this fraction of the content width → the block spans the columns. */
const DEFAULT_WIDE_RATIO = 0.6

export interface PaginateOptions<T extends ReflowBlock> {
  measure: TextMeasurer
  /** Exactly the text the caller will print for a block. */
  textOf: (block: T) => string
  /** Height of one sheet in points. `<= 0` disables growth (one sheet). */
  pageHeight: number
  /** Fraction of content width a block must cover to count as spanning. */
  wideRatio?: number
  /** Called for a block still taller than a whole sheet (unavoidable overlap). */
  onOverflow?: (block: T) => void
}

/** One column's running state as it packs blocks down the sheets. */
interface Column {
  left: number
  right: number
  /** Smallest source `y` in this column — where a continuation sheet starts. */
  originY: number
  /** Sheet the running flow is currently on. */
  sheet: number
  /** Running bottom on `sheet` (current-sheet coordinates). */
  bottom: number
  /** Still on the source sheet, so a block's own `y` is meaningful. */
  onFirstSheet: boolean
}

const EMPTY = Number.NEGATIVE_INFINITY

/** Same-column test as reflow: the ranges must share most of the narrower one. */
function sameColumn(column: Column, x: number, width: number): boolean {
  const overlap = Math.min(column.right, x + width) - Math.max(column.left, x)
  return overlap > Math.max(1, Math.min(column.right - column.left, width)) * 0.5
}

interface Placed {
  sheet: number
  y: number
}

/**
 * Splits `blocks` (in reading order) into sheets of `pageHeight`, growing a
 * new sheet rather than clamping at the bottom edge.
 *
 * Returns one array per non-empty sheet, each block carrying its re-based `y`.
 * With `pageHeight <= 0`, or when nothing overflows, the result is a single
 * sheet holding the input — and the very same block objects, so a caller can
 * still diff by identity.
 */
export function paginateBlocks<T extends ReflowBlock>(
  blocks: T[],
  options: PaginateOptions<T>,
): T[][] {
  const pageHeight = options.pageHeight
  if (!(pageHeight > 0) || blocks.length === 0) return [blocks]
  const wideRatio = options.wideRatio ?? DEFAULT_WIDE_RATIO

  // Content extent, derived from the blocks themselves (the export builder
  // measures the same boxes, so no page width has to be threaded through).
  let minLeft = Infinity
  let maxRight = -Infinity
  let minTop = Infinity
  for (const block of blocks) {
    minLeft = Math.min(minLeft, block.x)
    maxRight = Math.max(maxRight, block.x + block.width)
    minTop = Math.min(minTop, block.y)
  }
  const contentWidth = Math.max(1, maxRight - minLeft)
  // A page made entirely of wide blocks is a single column: nothing "spans"
  // anything, so it must not be split into a band plus phantom columns.
  const hasNarrow = blocks.some((block) => block.width < contentWidth * wideRatio)
  const isSpanning = (block: T): boolean => hasNarrow && block.width >= contentWidth * wideRatio

  // Recover the columns by clustering the non-spanning blocks on horizontal
  // overlap. Reading order already lists a whole column before the next one,
  // so a simple greedy walk is enough.
  const columns: Column[] = []
  for (const block of blocks) {
    if (isSpanning(block)) continue
    const column = columns.find((entry) => sameColumn(entry, block.x, block.width))
    if (column) {
      column.left = Math.min(column.left, block.x)
      column.right = Math.max(column.right, block.x + block.width)
      column.originY = Math.min(column.originY, block.y)
    } else {
      columns.push({
        left: block.x,
        right: block.x + block.width,
        originY: block.y,
        sheet: 0,
        bottom: EMPTY,
        onFirstSheet: true,
      })
    }
  }
  columns.sort((a, b) => a.left - b.left)

  const placed = new Map<string, Placed>()
  const columnFor = (block: T): Column | undefined =>
    columns.find((entry) => sameColumn(entry, block.x, block.width))

  for (const block of blocks) {
    const need = blockPrintHeight(block, options.textOf(block), options.measure)

    if (isSpanning(block)) {
      // Place it below the deepest column, then restart every column under it.
      let frontierSheet = 0
      for (const column of columns) frontierSheet = Math.max(frontierSheet, column.sheet)
      let top = minTop
      let found = false
      for (const column of columns) {
        if (column.sheet === frontierSheet && column.bottom > EMPTY) {
          top = Math.max(found ? top : column.bottom, column.bottom)
          found = true
        }
      }
      if (top + need > pageHeight) {
        frontierSheet += 1
        top = minTop
      }
      if (top + need > pageHeight) options.onOverflow?.(block)
      placed.set(block.id, { sheet: frontierSheet, y: top })

      const bandBottom = top + need
      for (const column of columns) {
        column.sheet = frontierSheet
        column.bottom = bandBottom
        column.onFirstSheet = false
      }
      continue
    }

    const column = columnFor(block)
    if (!column) {
      // No column claimed it (a lone block the clustering missed): keep its
      // source place on the first sheet rather than invent a home for it.
      placed.set(block.id, { sheet: 0, y: block.y })
      continue
    }

    // On the source sheet a block keeps its own `y` (pushed only by a taller
    // neighbour above); once the column has moved to a continuation sheet it
    // simply flows from the running bottom.
    let top =
      column.bottom > EMPTY
        ? Math.max(column.onFirstSheet ? block.y : column.bottom, column.bottom)
        : block.y
    if (top + need > pageHeight) {
      // A fresh sheet only helps when something already sits above; a first
      // block that is itself taller than the sheet cannot be rescued by moving.
      if (column.bottom > EMPTY) {
        column.sheet += 1
        column.onFirstSheet = false
        top = column.originY
      }
      if (top + need > pageHeight) options.onOverflow?.(block)
    }
    placed.set(block.id, { sheet: column.sheet, y: top })
    column.bottom = top + need
  }

  // Group into sheets, preserving reading order within each one. A block whose
  // `y` did not move comes back as the very same object.
  const sheets: T[][] = []
  for (const block of blocks) {
    const at = placed.get(block.id)
    if (!at) continue
    while (sheets.length <= at.sheet) sheets.push([])
    sheets[at.sheet].push(at.y === block.y ? block : { ...block, y: at.y })
  }
  return sheets.filter((sheet) => sheet.length > 0)
}
