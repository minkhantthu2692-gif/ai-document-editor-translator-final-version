/**
 * Discoverability (Phase 4, task 4.1; Phase 5.1 for the bare route): where
 * the editor lives and when it mounts.
 *
 * The written verdict is in `AUDIT_REPORT.md` §7.3; this file pins its factual
 * half at the route level — `/workspace/:projectId` opens the editor as soon
 * as the project has blocks, the bare `/workspace` entry redirects into the
 * most recently opened project (findings C-11/L-09) and shows the
 * create-project empty state only when there is nothing to open, and a
 * project with no blocks yet keeps the pipeline as the primary view rather
 * than an empty editor.
 *
 * `react-virtuoso` is mocked flat, exactly like `WorkspaceEditor.test.tsx`:
 * jsdom has no layout for the virtualiser to measure. The route/mount
 * behaviour under test does not depend on windowing.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode, Ref } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import i18n from '@/i18n'
import { AppDatabase, setDb } from '@/db/db'
import { blockRepo, pageRepo } from '@/db/repo-content'
import { projectRepo } from '@/db/repo-projects'
import { resetEditorStore } from '@/editor/store'
import { WorkspacePage } from './WorkspacePage'

interface VirtuosoProps {
  data?: unknown[]
  itemContent?: (index: number, item: unknown) => ReactNode
  computeItemKey?: (index: number, item: unknown) => string
  rangeChanged?: (range: { startIndex: number; endIndex: number }) => void
}

vi.mock('react-virtuoso', async () => {
  const { useEffect } = await import('react')
  return {
    Virtuoso: ({
      data,
      itemContent,
      computeItemKey,
      rangeChanged,
      ref,
    }: VirtuosoProps & { ref?: unknown }) => {
      const items = data ?? []
      useEffect(() => {
        if (items.length > 0) rangeChanged?.({ startIndex: 0, endIndex: items.length - 1 })
      }, [items.length, rangeChanged])
      return (
        <div data-testid="virtuoso-mock" ref={ref as Ref<HTMLDivElement>}>
          {items.map((item, index) => (
            <div key={computeItemKey?.(index, item) ?? String(index)}>
              {itemContent?.(index, item)}
            </div>
          ))}
        </div>
      )
    },
  }
})

const TRANSLATION = 'မြို့မှ နောက်ဆုံးရ သတင်းများ'

/** Resolves an i18n key whether or not the locales carry it yet. */
function label(key: string): string {
  return String(i18n.t(key))
}

function renderAt(path: string): ReturnType<typeof render> {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/workspace" element={<WorkspacePage />} />
          <Route path="/workspace/:projectId" element={<WorkspacePage />} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  )
}

describe('WorkspacePage discoverability', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(
      `aidt-workspacepage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    )
    setDb(db)
    await db.open()
    resetEditorStore()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the create-project empty state on bare /workspace when no projects exist', async () => {
    renderAt('/workspace')

    expect(await screen.findByText(label('projects.emptyTitle'))).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-editor')).toBeNull()
  })

  it('redirects bare /workspace to the most recently opened project (5.1)', async () => {
    const older = await projectRepo.create({
      name: 'Older project',
      sourceLang: 'en',
      targetLang: 'my',
    })
    const recent = await projectRepo.create({
      name: 'Recent project',
      sourceLang: 'en',
      targetLang: 'my',
    })
    // Deterministic recency regardless of creation order or clock ties:
    // `lastOpenedAt` is a timestamp, so the higher value is the more recent.
    await projectRepo.update(older.id, { lastOpenedAt: 1_000 })
    await projectRepo.update(recent.id, { lastOpenedAt: 2_000 })

    renderAt('/workspace')

    expect(await screen.findByText('Recent project')).toBeInTheDocument()
    expect(screen.queryByText(label('projects.emptyTitle'))).toBeNull()
    // The recent project has no blocks, so the pipeline stays the primary
    // view — the redirect opens the project, it does not force an editor.
    expect(screen.queryByTestId('workspace-editor')).toBeNull()
  })

  it('keeps the empty state when every project is archived (5.1)', async () => {
    const project = await projectRepo.create({
      name: 'Archived',
      sourceLang: 'en',
      targetLang: 'my',
    })
    await projectRepo.archive(project.id, true)

    renderAt('/workspace')

    expect(await screen.findByText(label('projects.emptyTitle'))).toBeInTheDocument()
  })

  it('opens the editor at /workspace/:projectId once the project has blocks', async () => {
    const project = await projectRepo.create({
      name: 'Discoverable',
      sourceLang: 'en',
      targetLang: 'my',
    })
    const page = await pageRepo.upsert({
      projectId: project.id,
      index: 0,
      width: 612,
      height: 792,
    })
    await blockRepo.upsert({
      projectId: project.id,
      pageId: page.id,
      order: 0,
      sourceText: 'Breaking news from the city',
      translatedText: TRANSLATION,
    })

    renderAt(`/workspace/${project.id}`)

    expect(
      await screen.findByTestId('workspace-editor', {}, { timeout: 4000 }),
    ).toBeInTheDocument()
    // It is the real editor, showing the translated document — not a shell.
    expect(await screen.findByText(TRANSLATION)).toBeInTheDocument()
  })

  it('withholds the editor while the project has no blocks yet', async () => {
    const project = await projectRepo.create({
      name: 'Fresh',
      sourceLang: 'en',
      targetLang: 'my',
    })

    renderAt(`/workspace/${project.id}`)

    expect(await screen.findByText(label('workspace.pipeline'))).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-editor')).toBeNull()
  })
})
