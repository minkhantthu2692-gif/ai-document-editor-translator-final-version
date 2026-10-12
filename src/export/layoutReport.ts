/**
 * The issues a layout pass reports about itself (Phase 03).
 *
 * Extracted from the export worker so the wording — which the audit holds as
 * an acceptance check ("`EXPORT_LAYOUT_CLIPPED` detail names the count") — is
 * unit-testable without a worker: the worker itself cannot be imported under
 * vitest without tripping its message listener.
 *
 * Two placements, one issue code:
 *
 *  - `reflow` — Adjust layout was on and the page-edge push parked a block;
 *    it overlaps the block above. The HTML/print exports reflow the same way.
 *  - `clamp` — source geometry was kept (the default image export), so the
 *    block's extra lines were cut at its own box edge instead of painting
 *    over the block below (C-03).
 */

import type { ExportIssue, ExportLayoutMode } from './types'

export interface LayoutIssueInput {
  /** False when the environment gave the export no text measurer. */
  measured: boolean
  /** Unique block ids the placement could not place inside its box. */
  clipped: readonly string[]
  /** Defaults to `reflow`, which is every pre-Phase-03 report. */
  mode?: ExportLayoutMode
}

const ESTIMATED_DETAIL =
  'this browser gave the export no text measurer, so blocks were re-flowed from an estimated character width and may sit a line out'

const REFLOW_DETAIL = (count: number): string =>
  `${count} blocks could not be re-flowed: the page box is fixed and the push ran out of edge, so they overlap the block above`

const CLAMP_DETAIL = (count: number): string =>
  `${count} blocks hold more text than their box can print at the 6pt minimum: the extra lines are clipped at the box edge in this image export, and the blocks below keep their original position. Turn on Adjust layout to push the text down, or edit the block`

/** Turns a layout pass's findings into issues (never throws, never empty-fit). */
export function layoutIssues(input: LayoutIssueInput): ExportIssue[] {
  const issues: ExportIssue[] = []
  if (!input.measured) {
    issues.push({ code: 'EXPORT_LAYOUT_ESTIMATED', fonts: [], detail: ESTIMATED_DETAIL })
  }
  const count = input.clipped.length
  if (count > 0) {
    const mode: ExportLayoutMode = input.mode ?? 'reflow'
    issues.push({
      code: 'EXPORT_LAYOUT_CLIPPED',
      fonts: [],
      count,
      mode,
      detail: mode === 'clamp' ? CLAMP_DETAIL(count) : REFLOW_DETAIL(count),
    })
  }
  return issues
}
