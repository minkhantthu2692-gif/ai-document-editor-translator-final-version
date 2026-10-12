/**
 * Page rasterisation for the workspace: thumbnails and text-less backgrounds.
 *
 * Both go through pdf.js onto an `OffscreenCanvas` inside the analysis worker,
 * so the main thread never touches pixels. The background render starts from a
 * normal page image and then *masks the text away*: for every text run we
 * sample the colours on a thin ring just outside its box (median over the four
 * sides) and repaint the box with them. Images and vector graphics outside the
 * boxes are untouched, which is exactly what the translated text overlay needs.
 * Pages whose text lives only in the image (scanned, OCR) have no runs at all,
 * so the caller can hand in stored block boxes as erase geometry — `planErase`
 * decides what is actually painted.
 *
 * Renders are cancellable — the workspace drops stale requests as the user
 * scrolls, and `renderPage` exposes the underlying pdf.js render task.
 */

import type { PDFPageProxy, RenderTask } from 'pdfjs-dist'
import type { PageContentClass } from '@/db/types'
import type { BBox } from './stableId'

/** The page-rectangle frame every helper here speaks: PDF points, top-left. */
export type { BBox } from './stableId'

export interface RenderPageOptions {
  /** Viewport scale (1 = 72 dpi). Thumbnails use ~0.15–0.25. */
  scale: number
  /** Repaint the text boxes with their sampled surroundings. */
  maskText?: boolean
  /**
   * Also cut these page rectangles out of the finished render and hand them
   * back separately (see `PageCrop`). This is how the figure pipeline feeds
   * the formats that can only embed standalone pictures — DOCX, EPUB and
   * Markdown — without ever shipping whole pages back to the main thread.
   *
   * Asking for crops turns the render into a figure render: the whole-page
   * blob is not encoded, because the only caller that asks is the one that
   * does not want the page.
   */
  crops?: readonly FigureCropTarget[]
  /**
   * Extra rectangles to mask away alongside the text layer (page space in PDF
   * points, top-left origin — the same frame as a `BBox`).
   *
   * These are *stored block boxes*, and they exist for pages whose text lives
   * only in the image: a scanned page has no `getTextContent()` runs at all,
   * so without them the render keeps its original text and the translated
   * overlay prints a second copy over it. Applied through `planErase`, which
   * skips any box already covered by a text-layer run, so the padded box of a
   * text block never widens the repaint over the art around it.
   */
  eraseBoxes?: readonly BBox[]
}

/** A rectangle of the page an export wants as its own picture. */
export interface FigureCropTarget {
  /** Identity echoed back on the crop; unique within one render request. */
  key: string
  /** Page space in PDF points, top-left origin — the same frame as a `BBox`. */
  bbox: BBox
}

export interface PageCrop {
  key: string
  blob: Blob
}

export interface RenderResult {
  /**
   * The whole page, encoded as WebP (PNG where WebP is unavailable). `null`
   * when the caller asked for `crops` only — a figure-only export has no use
   * for the page and should not pay to encode it.
   */
  page: Blob | null
  /** The requested cut-outs, PNG, in request order — empty unless asked for. */
  crops: PageCrop[]
}

export interface RenderHandle {
  promise: Promise<RenderResult>
  /** Aborts the pdf.js render task; the promise rejects with a cancel error. */
  cancel: () => void
}

interface ViewportLike {
  width: number
  height: number
  /** PDF user space → viewport pixels. */
  convertToViewportPoint(x: number, y: number): number[]
}

interface TextItemLike {
  str?: string
  transform?: number[]
  width?: number
  height?: number
}

type MaskableContext = CanvasRenderingContext2D & {
  getImageData?: (x: number, y: number, w: number, h: number) => ImageData
}

/** Rejection reason used by `cancel()` (pdf.js throws its own subclass). */
export function isRenderCancelled(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: string }).name
  return name === 'RenderingCancelledException' || name === 'AbortError'
}

function toBlob(
  canvas: OffscreenCanvas,
  type: 'image/webp' | 'image/png' = 'image/webp',
): Promise<Blob> {
  return canvas.convertToBlob({ type, quality: 0.75 }).then(async (blob) => {
    // Some engines cannot encode WebP — fall back to PNG rather than fail.
    if (blob && blob.type === type) return blob
    return canvas.convertToBlob({ type: 'image/png' })
  })
}

/**
 * Cuts the requested rectangles out of a finished page render.
 *
 * A crop that lands outside the sheet (a box clamped by extraction, or one
 * whose block straddles the trim) is clipped rather than dropped, and one that
 * rounds down to nothing is skipped — an export would rather lose a decorative
 * sliver than embed a zero-width picture.
 *
 * PNG on purpose: `docx` stores images by MIME type and only knows
 * `jpg|png|gif|bmp`, while EPUB readers are still uneven about WebP. The page
 * itself stays WebP because it is the much larger asset.
 */
async function cutOut(
  canvas: OffscreenCanvas,
  scale: number,
  figures: readonly FigureCropTarget[],
): Promise<PageCrop[]> {
  if (figures.length === 0) return []
  const out: PageCrop[] = []
  for (const target of figures) {
    const x = Math.max(0, Math.round(target.bbox.x * scale))
    const y = Math.max(0, Math.round(target.bbox.y * scale))
    const right = Math.min(canvas.width, Math.round((target.bbox.x + target.bbox.w) * scale))
    const bottom = Math.min(canvas.height, Math.round((target.bbox.y + target.bbox.h) * scale))
    const w = right - x
    const h = bottom - y
    if (w < 1 || h < 1) continue
    const piece = new OffscreenCanvas(w, h)
    const context = piece.getContext('2d')
    if (!context) continue
    context.drawImage(canvas, x, y, w, h, 0, 0, w, h)
    out.push({ key: target.key, blob: await toBlob(piece, 'image/png') })
  }
  return out
}

/** Text runs as viewport-space boxes (top-left origin). */
async function textBoxes(
  page: PDFPageProxy,
  viewport: ViewportLike,
): Promise<
  Array<{
    x: number
    y: number
    w: number
    h: number
  }>
> {
  const content = await page.getTextContent()
  const boxes: Array<{ x: number; y: number; w: number; h: number }> = []

  for (const raw of content.items as TextItemLike[]) {
    const str = typeof raw.str === 'string' ? raw.str : ''
    if (str.trim().length === 0 || !raw.transform || !Number.isFinite(raw.width)) continue

    const [, , , , originX, originY] = raw.transform
    const width = Math.max(0, raw.width ?? 0)
    const fontSize = Math.max(1, raw.height ?? Math.abs(raw.transform[3]) ?? 10)
    if (width <= 0.5) continue

    // Baseline origin → the visual box: roughly one em above, a quarter below.
    const [x0, y0] = viewport.convertToViewportPoint(originX, originY - fontSize * 0.28)
    const [x1, y1] = viewport.convertToViewportPoint(originX + width, originY + fontSize * 1.02)
    const x = Math.min(x0, x1)
    const y = Math.min(y0, y1)
    const w = Math.abs(x1 - x0)
    const h = Math.abs(y1 - y0)
    if (w < 0.5 || h < 0.5) continue
    boxes.push({ x, y, w, h })
  }
  return boxes
}

function median(values: number[]): number {
  if (values.length === 0) return 255
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** A rectangle in viewport pixels, top-left origin. */
interface MaskBox {
  x: number
  y: number
  w: number
  h: number
}

/** Fraction of the smaller box the two boxes share. */
function overlapRatio(a: MaskBox, b: MaskBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (w <= 0 || h <= 0) return 0
  const intersection = w * h
  const smallest = Math.min(a.w * a.h, b.w * b.h)
  return smallest > 0 ? intersection / smallest : 0
}

/**
 * What gets painted away before the translation goes on top.
 *
 *  - Every text-layer run is masked: those boxes are exact glyph extents, so
 *    erasing them cannot touch anything but text.
 *  - The caller's stored boxes are *extra* geometry for text the text layer
 *    cannot see. On a scanned page there are no runs at all, so all of them
 *    are used — that is the whole point. On a hybrid page (text layer plus
 *    OCR'd image regions) the text-derived blocks are skipped because their
 *    runs already erased them, and only the genuinely image-only regions are
 *    painted away.
 *
 * A skipped-or-empty result is safe, not a failure: a page with neither runs
 * nor stored boxes simply renders unmasked.
 */
export function planErase(
  textLayerBoxes: readonly MaskBox[],
  storedBoxes: readonly BBox[] | undefined,
  scale: number,
): MaskBox[] {
  const planned: MaskBox[] = [...textLayerBoxes]
  if (!storedBoxes || storedBoxes.length === 0) return planned
  for (const box of storedBoxes) {
    const scaled: MaskBox = {
      x: box.x * scale,
      y: box.y * scale,
      w: box.w * scale,
      h: box.h * scale,
    }
    if (!(scaled.w > 0) || !(scaled.h > 0)) continue
    if (textLayerBoxes.some((run) => overlapRatio(run, scaled) >= 0.5)) continue
    planned.push(scaled)
  }
  return planned
}

/**
 * A short stable signature of a set of erase boxes, so render dedupe keys can
 * tell an erase request apart from an identical-looking one without it (the
 * client supersede map and the worker's per-page render key both use it).
 */
export function eraseSignature(boxes: readonly BBox[] | undefined): string {
  if (!boxes || boxes.length === 0) return ''
  let sum = 0
  for (const box of boxes) sum += box.x + box.y + box.w + box.h
  return `${boxes.length}:${Math.round(sum)}`
}

/** The block fields erasure needs — `BlockRecord` and `ExportBlock` both fit. */
export interface ErasableBlock {
  x: number
  y: number
  width: number
  height: number
  sourceText: string
  translatedText: string
}

/**
 * Stored erase geometry for one page, per `contentClass`.
 *
 * Only pages whose text lives (partly) in the image qualify — `scanned` and
 * `mixed`. Their blocks came from OCR, and a render with no text-layer runs
 * masks nothing at all, so without this geometry the background keeps the
 * original text and whatever sits on top prints a second copy of it (C-02).
 * `text`/`complex`/`empty` pages get nothing: their runs are exact glyph
 * extents, and a padded block box would widen the repaint over the art around
 * it. `planErase` applies the same reasoning again render-side, so a box that
 * slipped through here still cannot double-erase a run.
 *
 * A block with no text at all is skipped too — nothing paints over it, so its
 * pixels must stay. Every other block is printed on export (its translation,
 * or the source fallback in `textOf`), which is what makes masking its box
 * safe: content is never erased without being shown again.
 */
export function storedEraseBoxes(
  contentClass: PageContentClass,
  blocks: readonly ErasableBlock[],
): BBox[] {
  if (contentClass !== 'scanned' && contentClass !== 'mixed') return []
  const boxes: BBox[] = []
  for (const block of blocks) {
    if ((block.translatedText || block.sourceText).trim().length === 0) continue
    if (!(block.width > 0) || !(block.height > 0)) continue
    boxes.push({ x: block.x, y: block.y, w: block.width, h: block.height })
  }
  return boxes
}

/**
 * Repaints one box with the median colour of a ring 2 px outside it.
 * Falls back to white when the ring cannot be read (fully transparent edges).
 */
function inpaintBox(
  context: MaskableContext,
  box: { x: number; y: number; w: number; h: number },
): void {
  const margin = 2
  const left = Math.max(0, Math.floor(box.x))
  const top = Math.max(0, Math.floor(box.y))
  const width = Math.ceil(box.w)
  const height = Math.ceil(box.h)
  if (width <= 0 || height <= 0) return

  const reds: number[] = []
  const greens: number[] = []
  const blues: number[] = []
  const step = 4

  const sample = (x: number, y: number): void => {
    if (x < 0 || y < 0) return
    try {
      const pixel = context.getImageData(x, y, 1, 1).data
      // Skip transparent pixels — they are page background, not ink.
      if (pixel[3] < 8) return
      reds.push(pixel[0])
      greens.push(pixel[1])
      blues.push(pixel[2])
    } catch {
      // getImageData can throw on tainted canvases; ignore.
    }
  }

  const right = left + width
  const bottom = top + height
  for (let x = left; x <= right; x += step) {
    sample(x, top - margin)
    sample(x, bottom + margin)
  }
  for (let y = top; y <= bottom; y += step) {
    sample(left - margin, y)
    sample(right + margin, y)
  }

  const fill = `rgb(${median(reds)}, ${median(greens)}, ${median(blues)})`
  context.fillStyle = fill
  context.fillRect(left, top, width, height)
}

/** Starts rendering one page; call `cancel()` to abort a stale request. */
export function renderPage(page: PDFPageProxy, options: RenderPageOptions): RenderHandle {
  const scale = Math.max(0.02, Math.min(8, options.scale))
  const viewport = page.getViewport({ scale })
  const width = Math.max(1, Math.round(viewport.width))
  const height = Math.max(1, Math.round(viewport.height))
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true }) as MaskableContext | null

  let task: RenderTask | null = null
  let cancelled = false

  const crops = options.crops ?? []

  const promise = (async (): Promise<RenderResult> => {
    if (!context) throw new Error('2D canvas context unavailable')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)

    task = page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
      canvas: canvas as unknown as HTMLCanvasElement,
      background: '#ffffff',
    })

    await task.promise

    if (options.maskText && !cancelled) {
      const boxes = planErase(await textBoxes(page, viewport), options.eraseBoxes, scale)
      for (const box of boxes) {
        if (cancelled) break
        inpaintBox(context, box)
      }
    }
    if (cancelled) throw new Error('render cancelled')
    const cut = await cutOut(canvas, scale, crops)
    const pageBlob = crops.length > 0 ? null : await toBlob(canvas)
    return { page: pageBlob, crops: cut }
  })()

  return {
    promise,
    cancel: () => {
      cancelled = true
      try {
        task?.cancel()
      } catch {
        // The task may already have settled.
      }
    },
  }
}
