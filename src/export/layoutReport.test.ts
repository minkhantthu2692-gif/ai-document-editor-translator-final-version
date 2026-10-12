/**
 * Layout-report wording (Phase 03).
 *
 * The worker cannot be imported under vitest without tripping its message
 * listener, so the issue text lives in `layoutReport` and is pinned here:
 * both placement modes, the count in the detail, and byte-identical reflow
 * copy for every report that existed before the clamp did.
 */

import { describe, expect, it } from 'vitest'
import { layoutIssues } from './layoutReport'

describe('layoutIssues', () => {
  it('reports a measurement fallback even when nothing clipped', () => {
    const issues = layoutIssues({ measured: false, clipped: [] })
    expect(issues).toHaveLength(1)
    expect(issues[0].code).toBe('EXPORT_LAYOUT_ESTIMATED')
    expect(issues[0].detail).toContain('estimated character width')
  })

  it('says nothing when every block fit and the fonts were real', () => {
    expect(layoutIssues({ measured: true, clipped: [] })).toEqual([])
  })

  it('clamp mode: names the count and how the block was cut (C-03)', () => {
    const [issue] = layoutIssues({ measured: true, clipped: ['a', 'b'], mode: 'clamp' })
    expect(issue.code).toBe('EXPORT_LAYOUT_CLIPPED')
    expect(issue.count).toBe(2)
    expect(issue.mode).toBe('clamp')
    expect(issue.detail).toContain('2 blocks')
    expect(issue.detail).toContain('clipped at the box edge')
    expect(issue.detail).toContain('image export')
  })

  it('reflow mode keeps the pre-Phase-03 wording byte for byte', () => {
    const [issue] = layoutIssues({ measured: true, clipped: ['a'], mode: 'reflow' })
    expect(issue.detail).toBe(
      '1 blocks could not be re-flowed: the page box is fixed and the push ran out of edge, so they overlap the block above',
    )
    expect(issue.mode).toBe('reflow')
  })

  it('defaults to reflow, so an old report (and the HTML path) reads the same', () => {
    const [issue] = layoutIssues({ measured: true, clipped: ['a'] })
    expect(issue.mode).toBe('reflow')
    expect(issue.detail).toContain('could not be re-flowed')
  })

  it('can report both problems at once', () => {
    const issues = layoutIssues({ measured: false, clipped: ['a'], mode: 'clamp' })
    expect(issues.map((issue) => issue.code)).toEqual([
      'EXPORT_LAYOUT_ESTIMATED',
      'EXPORT_LAYOUT_CLIPPED',
    ])
  })
})
