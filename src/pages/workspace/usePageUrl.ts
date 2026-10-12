/**
 * Page artwork for the split view (Phase 4).
 *
 * Both panes are backed by a rendered page: `thumbnail` for the original
 * (the PDF as it looks today) and `background` for the translated pane (the
 * artwork with the original text erased, ready for our own text on top).
 *
 * Requests go through the analysis worker and the shared object-URL LRU, and
 * are cancelled when a row leaves the virtualised window — scrolling a
 * 300-page document must not queue 300 renders.
 */

import { useEffect, useRef, useState } from 'react'
import { analysisClient } from '@/pdf/analysisClient'
import { ensureProjectDocument } from '@/pdf/projectAnalysis'
import { eraseSignature, type BBox } from '@/pdf/pageRender'
import { getCachedUrl, putCachedUrl, renderCacheKey } from '@/pdf/renderCache'

/**
 * Page points → pixels for the pane artwork. Fixed (not tied to the zoom) so
 * one render serves every zoom level — the text layer is DOM text and stays
 * crisp regardless; only the graphics scale.
 */
export const PAGE_IMAGE_SCALE = 1.5

export type PageImageMode = 'thumbnail' | 'background'

/** Opens the project's source PDF once and hands back its worker file id. */
export function useProjectFileId(projectId: string | null): string | null {
  const [fileId, setFileId] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    if (!projectId) {
      setFileId(null)
      return undefined
    }
    ensureProjectDocument(projectId)
      .then((opened) => {
        if (alive) setFileId(opened.fileId)
      })
      .catch(() => {
        if (alive) setFileId(null)
      })
    return () => {
      alive = false
    }
  }, [projectId])

  return fileId
}

/** Object URL for one rendered page, fetched on demand and cancellable. */
export function usePageUrl(
  fileId: string | null,
  pageIndex: number,
  mode: PageImageMode,
  /** Stored boxes to erase from a `background` render (scanned/OCR pages). */
  eraseBoxes?: readonly BBox[],
): string | null {
  // Only the *set* of boxes changes what the picture looks like, so the
  // signature — not the array identity — is what the cache and effect key on:
  // a translation edit must not re-render the artwork underneath it.
  const erase = mode === 'background' ? eraseSignature(eraseBoxes) : ''
  const key = fileId
    ? renderCacheKey(fileId, pageIndex, mode, PAGE_IMAGE_SCALE, erase)
    : null
  const boxesRef = useRef(eraseBoxes)
  boxesRef.current = eraseBoxes
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!fileId || !key) {
      setUrl(null)
      return undefined
    }
    const cached = getCachedUrl(key)
    if (cached) {
      setUrl(cached)
      return undefined
    }

    let settled = false
    let alive = true
    const boxes = mode === 'background' ? boxesRef.current : undefined
    analysisClient
      .render(fileId, pageIndex, PAGE_IMAGE_SCALE, mode, {
        ...(boxes && boxes.length > 0 ? { eraseBoxes: boxes } : {}),
      })
      .then((blob) => {
        settled = true
        const next = putCachedUrl(key, blob)
        if (alive) setUrl(next)
      })
      .catch(() => {
        settled = true
      })

    return () => {
      alive = false
      if (!settled) analysisClient.cancelRender(fileId, pageIndex, PAGE_IMAGE_SCALE, mode, erase)
    }
  }, [fileId, key, pageIndex, mode, erase])

  return url
}
