/**
 * Page rasterisation for the workspace: thumbnails and text-less backgrounds.
 *
 * Both go through pdf.js onto an `OffscreenCanvas` inside the analysis worker,
 * so the main thread never touches pixels. The background render starts from a
 * normal page image and then *masks the text away*: for every text run we
 * sample the colours on a thin ring just outside its box (the median of each
 * side) and repaint the box with those colours blended per pixel, so the patch
 * continues into the ring instead of ending in a hard edge. Images and vector
 * graphics outside the boxes are untouched, which is exactly what the
 * translated text overlay needs.
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
    const fontSize = Math.max(1, raw.height ?? Math.abs(raw.transform[3]) ?? 10)
    // A run with degenerate width metrics still paints pixels — estimate its
    // extent instead of skipping it, or stray source glyphs stay visible
    // under the translation (L-10).
    const width = runExtent(str, fontSize, Math.max(0, raw.width ?? 0))
    if (width < 0.5) continue

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

/** An opaque [r, g, b] colour, 0..255 per channel. */
export type Rgba = readonly [number, number, number]

/** Ring samples for one side of a box, split by channel. */
export interface RingSamples {
  r: number[]
  g: number[]
  b: number[]
}

/**
 * Median colour of one ring side; `null` when the side produced no samples
 * (fully transparent, off-canvas, or unreadable).
 */
export function medianColor(samples: RingSamples): Rgba | null {
  if (samples.r.length === 0) return null
  return [median(samples.r), median(samples.g), median(samples.b)]
}

/** The four side medians a repaint is painted from. */
export interface RingSides {
  top: Rgba
  bottom: Rgba
  left: Rgba
  right: Rgba
}

/**
 * Fills in the sides a box could not sample — a box touching the canvas edge
 * has no ring on that side — with the mean of the sides that did sample, so
 * the patch still continues into whatever surrounds it. `null` only when
 * nothing opaque was found at all; the caller keeps its white-fill fallback.
 */
export function resolveRingSides(sides: {
  top: Rgba | null
  bottom: Rgba | null
  left: Rgba | null
  right: Rgba | null
}): RingSides | null {
  const known = [sides.top, sides.bottom, sides.left, sides.right].filter(
    (side): side is Rgba => side !== null,
  )
  if (known.length === 0) return null
  const mean: Rgba = [
    Math.round(known.reduce((sum, c) => sum + c[0], 0) / known.length),
    Math.round(known.reduce((sum, c) => sum + c[1], 0) / known.length),
    Math.round(known.reduce((sum, c) => sum + c[2], 0) / known.length),
  ]
  return {
    top: sides.top ?? mean,
    bottom: sides.bottom ?? mean,
    left: sides.left ?? mean,
    right: sides.right ?? mean,
  }
}

/** The box's four corner colours for the blend (see `blendCorners`). */
export interface BlendCorners {
  tl: Rgba
  tr: Rgba
  bl: Rgba
  br: Rgba
}

/**
 * Corner colours for the per-pixel blend: each corner is the mean of the two
 * sides meeting there, so every edge of the box starts at exactly its own
 * side's median — the patch continues into the ring instead of ending in the
 * hard rectangle edge that used to show on gradients and figures (L-07).
 *
 * A ring whose four medians are equal — every normal paper background — makes
 * all four corners that same colour, so the paint degenerates to the old flat
 * fill exactly: one code path, no variance threshold to get wrong.
 */
export function blendCorners(sides: RingSides): BlendCorners {
  const mix = (a: Rgba, b: Rgba): Rgba => [
    Math.round((a[0] + b[0]) / 2),
    Math.round((a[1] + b[1]) / 2),
    Math.round((a[2] + b[2]) / 2),
  ]
  return {
    tl: mix(sides.top, sides.left),
    tr: mix(sides.top, sides.right),
    bl: mix(sides.bottom, sides.left),
    br: mix(sides.bottom, sides.right),
  }
}

/**
 * Colour at `(u, v)` inside the box, `u` across and `v` down, both 0..1
 * (clamped). Bilinear across the four corner colours.
 */
export function blendAt(corners: BlendCorners, u: number, v: number): Rgba {
  const uu = u <= 0 ? 0 : u >= 1 ? 1 : u
  const vv = v <= 0 ? 0 : v >= 1 ? 1 : v
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
  const channel = (i: number): number =>
    Math.round(lerp(lerp(corners.tl[i], corners.tr[i], uu), lerp(corners.bl[i], corners.br[i], uu), vv))
  return [channel(0), channel(1), channel(2)]
}

/**
 * Width in PDF units of a text run the mask should cover (L-10).
 *
 * A run whose metrics came back degenerate — width 0 or a fraction of a point
 * for glyphs that are visibly there — still paints pixels; skipping it used
 * to leave stray source characters under the translation. Estimate the extent
 * from the font size instead: ~0.75 em per glyph balances the typical Latin
 * advance (~0.5 em) against full-width and stacked scripts (~1 em), and
 * over-covering is safe because the box is repainted from its ring, while
 * under-covering is exactly the bug. Only callers with no estimate possible
 * (blank strings — filtered before this is reached) may still skip.
 */
export function runExtent(str: string, fontSize: number, reportedWidth: number): number {
  if (reportedWidth > 0.5) return reportedWidth
  const glyphs = Math.max(1, str.trim().length)
  return fontSize * glyphs * 0.75
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
 * Repaints one box from the median colour of each ring side, blended per
 * pixel (see `blendCorners`/`blendAt`): text over paper repaints as the flat
 * colour it always did, while text over a gradient or a figure repaints with
 * the colours that surround each edge rather than one average — so the patch
 * no longer ends in a visible rectangle (L-07). Falls back to white when the
 * ring cannot be read at all (fully transparent edges).
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

  const samples: Record<'top' | 'bottom' | 'left' | 'right', RingSamples> = {
    top: { r: [], g: [], b: [] },
    bottom: { r: [], g: [], b: [] },
    left: { r: [], g: [], b: [] },
    right: { r: [], g: [], b: [] },
  }
  const step = 4

  const sample = (side: keyof typeof samples, x: number, y: number): void => {
    if (x < 0 || y < 0) return
    try {
      const pixel = context.getImageData(x, y, 1, 1).data
      // Skip transparent pixels — they are page background, not ink.
      if (pixel[3] < 8) return
      samples[side].r.push(pixel[0])
      samples[side].g.push(pixel[1])
      samples[side].b.push(pixel[2])
    } catch {
      // getImageData can throw on tainted canvases; ignore.
    }
  }

  const right = left + width
  const bottom = top + height
  for (let x = left; x <= right; x += step) {
    sample('top', x, top - margin)
    sample('bottom', x, bottom + margin)
  }
  for (let y = top; y <= bottom; y += step) {
    sample('left', left - margin, y)
    sample('right', right + margin, y)
  }

  const ring = resolveRingSides({
    top: medianColor(samples.top),
    bottom: medianColor(samples.bottom),
    left: medianColor(samples.left),
    right: medianColor(samples.right),
  })
  if (!ring) {
    context.fillStyle = 'rgb(255, 255, 255)'
    context.fillRect(left, top, width, height)
    return
  }
  const corners = blendCorners(ring)

  let region: ImageData | null = null
  try {
    region = context.getImageData(left, top, width, height)
  } catch {
    // Tainted canvas: fall back to the flat centre colour of the blend.
    const mid = blendAt(corners, 0.5, 0.5)
    context.fillStyle = `rgb(${mid[0]}, ${mid[1]}, ${mid[2]})`
    context.fillRect(left, top, width, height)
    return
  }

  const buffer = region.data
  for (let row = 0; row < height; row++) {
    const v = height > 1 ? row / (height - 1) : 0
    for (let col = 0; col < width; col++) {
      const u = width > 1 ? col / (width - 1) : 0
      const [r, g, b] = blendAt(corners, u, v)
      const offset = (row * width + col) * 4
      buffer[offset] = r
      buffer[offset + 1] = g
      buffer[offset + 2] = b
      buffer[offset + 3] = 255
    }
  }
  context.putImageData(region, left, top)
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
