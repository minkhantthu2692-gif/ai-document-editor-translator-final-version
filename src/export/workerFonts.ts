/**
 * Font registration for the export worker (C-04 / L-03).
 *
 * The worker measures text for reflow and paints the raster sheets on *its
 * own* canvas, and a canvas only shapes with fonts its thread has been given:
 * the main thread's `document.fonts` does not reach in here. Before this
 * module existed, the exported PDF measured Myanmar with whatever system
 * fallback the machine had — wrong line breaks, wrong glyph advances — while
 * the on-screen preview used the real bundled faces. So every build now loads
 * the collected faces (`collectFontFaces`, URLs already resolved on the main
 * thread) into this thread's `FontFaceSet` *before* anything measures.
 *
 * A face that will not load is never fatal: it degrades to the fallback stack
 * and is reported through `EXPORT_FONT_MISSING`, exactly like a family the
 * browser cannot resolve. `FontFace` does not exist under jsdom/vitest, so
 * the module must behave the same way there — report, never throw.
 */

import type { FontFaceInfo } from '@/fonts'
import type { ExportIssue } from './types'

export interface FontRegistration {
  /** Families with at least one face loaded into this thread. */
  registered: string[]
  /** Families no face could be loaded for (deduplicated, in input order). */
  failed: string[]
}

interface FontFaceLike {
  load(): Promise<unknown>
}

/** The injectable global scope — exported so tests can pass a fake one. */
export interface FontScope {
  FontFace?: new (
    family: string,
    source: string,
    descriptors?: Record<string, string>,
  ) => FontFaceLike
  fonts?: { add(face: FontFaceLike): void }
}

/**
 * `family|weight|style|range` of every face already added to this thread, so
 * repeated exports in one session do not stack duplicate faces into the
 * worker's `FontFaceSet`. Failures are deliberately *not* remembered — the
 * next export retries them.
 */
const loaded = new Set<string>()

/** Test hook: forget which faces this module has already registered. */
export function clearWorkerFontRegistration(): void {
  loaded.clear()
}

/**
 * Loads `faces` into `scope`'s `FontFaceSet`. Never rejects; one bad face
 * never stops the others.
 */
export async function registerWorkerFonts(
  faces: readonly FontFaceInfo[],
  scope: FontScope = globalThis as unknown as FontScope,
): Promise<FontRegistration> {
  const registered = new Set<string>()
  const failed: string[] = []
  const noteFailure = (family: string): void => {
    if (!failed.includes(family)) failed.push(family)
  }

  const FontFaceCtor = scope.FontFace
  const set = scope.fonts
  for (const face of faces) {
    const key = `${face.family}|${face.weight}|${face.style}|${face.unicodeRange}`
    if (loaded.has(key)) {
      registered.add(face.family)
      continue
    }
    if (typeof FontFaceCtor !== 'function' || !set) {
      noteFailure(face.family)
      continue
    }
    try {
      const font = new FontFaceCtor(face.family, `url("${face.url}")`, {
        weight: face.weight,
        style: face.style,
        ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}),
      })
      await font.load()
      set.add(font)
      loaded.add(key)
      registered.add(face.family)
    } catch {
      noteFailure(face.family)
    }
  }
  return { registered: [...registered], failed }
}

/**
 * The `EXPORT_FONT_MISSING` entries a failed registration is worth, given
 * what the document actually needs:
 *
 *  - a failed family some block names → always report (its text is measured
 *    and painted with the fallback stack now);
 *  - a failed stack family on a document *with* Myanmar text → report (the
 *    export stack exists to shape Myanmar);
 *  - a failed stack family on a Latin-only document → stay quiet (nothing
 *    in the file ever reaches for it).
 *
 * `faces` are collected as `[...usedFamilies(doc), ...EXPORT_STACK_FAMILIES]`,
 * which is what makes those the only two cases that can occur.
 */
export function fontRegistrationIssues(
  registration: FontRegistration,
  options: { usedFamilies: readonly string[]; hasMyanmar: boolean },
): ExportIssue[] {
  if (registration.failed.length === 0) return []
  const used = new Set(options.usedFamilies.map((family) => family.toLowerCase()))
  const reportable = registration.failed.filter(
    (family) => options.hasMyanmar || used.has(family.toLowerCase()),
  )
  if (reportable.length === 0) return []
  return [
    {
      code: 'EXPORT_FONT_MISSING',
      fonts: reportable,
      detail: `the export worker could not load ${reportable.join(
        ', ',
      )}; their text was measured and painted with the fallback stack`,
    },
  ]
}
