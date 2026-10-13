/**
 * Block inspector render test: the three tabs come up, the seeded block's
 * translation and its pending suggestion are shown with Accept/Reject, and
 * the Document tab counts the block.
 *
 * IndexedDB is faked exactly the way `src/pages/KnowledgePage.test.tsx` does
 * it — a uniquely named database per test so the repositories work unmocked.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { AppDatabase, setDb } from '@/db/db'
import { blockRepo, pageRepo } from '@/db/repo-content'
import { projectRepo } from '@/db/repo-projects'
import { collectExportDocument } from '@/export/collect'
import { buildHtmlDocument, DEFAULT_HTML_OPTIONS } from '@/export/html'
import { loadEditorBlocks } from '@/editor/blocks'
import { undo } from '@/editor/history'
import { resetEditorStore, useEditorStore } from '@/editor/store'
import { BlockInspector } from './BlockInspector'

const PROJECT_ID = 'prj_block_inspector'
const TRANSLATION = 'မြို့မှ နောက်ဆုံးရ သတင်းများ'
const SUGGESTION = 'မြို့တွင်းမှ နောက်ဆုံး သတင်းများ'

/** Resolves an i18n key whether or not the locales carry it yet. */
function label(key: string): string {
  return String(i18n.t(key))
}

describe('BlockInspector', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-inspector-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
    resetEditorStore()
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the tabs, the translation, the suggestion and the block count', async () => {
    const page = await pageRepo.upsert({ projectId: PROJECT_ID, index: 0 })
    await blockRepo.upsert({
      projectId: PROJECT_ID,
      pageId: page.id,
      order: 0,
      kind: 'paragraph',
      sourceText: 'Breaking news from the city',
      translatedText: TRANSLATION,
      suggestedText: SUGGESTION,
      suggestedModel: 'gemini-2.0-flash',
      suggestedAt: Date.now() - 60_000,
      status: 'edited',
    })
    const blocks = await loadEditorBlocks(PROJECT_ID)

    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <BlockInspector projectId={PROJECT_ID} block={blocks[0]} blocks={blocks} />
        </MemoryRouter>
      </I18nextProvider>,
    )

    expect(screen.getAllByRole('tab')).toHaveLength(3)

    expect(await screen.findByLabelText(label('editor.block.translation'))).toHaveValue(TRANSLATION)

    expect(screen.getByText(label('editor.block.suggestion'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: label('editor.block.accept') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: label('editor.block.reject') })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: label('editor.tabs.document') }))
    expect(screen.getByText(label('workspace.blockCount')).nextElementSibling).toHaveTextContent(
      '1',
    )
  })

  /**
   * Position & size (Phase 4): the geometry card writes x/y/width/height
   * through the command stack — so it is auto-saved and undoable like every
   * other edit — and the export collector reads the very same four fields back
   * out of the row, which is the whole point of a *pre-export* position edit.
   */
  it('saves position and size edits through the command stack into the export', async () => {
    const project = await projectRepo.create({
      name: 'Geometry',
      sourceLang: 'en',
      targetLang: 'my',
    })
    const page = await pageRepo.upsert({
      projectId: project.id,
      index: 0,
      width: 612,
      height: 792,
    })
    const created = await blockRepo.upsert({
      projectId: project.id,
      pageId: page.id,
      order: 0,
      kind: 'paragraph',
      sourceText: 'Breaking news from the city',
      translatedText: TRANSLATION,
      x: 72,
      y: 144,
      width: 300,
      height: 40,
    })
    const blocks = await loadEditorBlocks(project.id)
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <BlockInspector projectId={project.id} block={blocks[0]} blocks={blocks} />
        </MemoryRouter>
      </I18nextProvider>,
    )

    // The stored geometry shows up in the inputs; save starts inert.
    expect(await screen.findByTestId('geom-x')).toHaveValue(72)
    expect(screen.getByTestId('geom-y')).toHaveValue(144)
    expect(screen.getByTestId('geom-save')).toBeDisabled()

    fireEvent.change(screen.getByTestId('geom-y'), { target: { value: '200' } })
    fireEvent.change(screen.getByTestId('geom-width'), { target: { value: '320.5' } })

    const save = screen.getByTestId('geom-save')
    expect(save).toBeEnabled()
    fireEvent.click(save)

    // Auto-saved: exactly the changed fields were written, the rest untouched.
    await waitFor(async () => {
      const row = await blockRepo.get(created.id)
      expect(row).toMatchObject({ x: 72, y: 200, width: 320.5, height: 40 })
    })
    await waitFor(() => expect(useEditorStore.getState().undoStack).toHaveLength(1))

    // The export sees the edited geometry, not the original one.
    const doc = await collectExportDocument({ projectId: project.id })
    const exported = doc.pages[0].blocks.find((entry) => entry.id === created.id)
    expect(exported).toMatchObject({ x: 72, y: 200, width: 320.5, height: 40 })
    const html = buildHtmlDocument(doc, { ...DEFAULT_HTML_OPTIONS, title: project.name })
    expect(html).toContain('top:200pt;width:320.5pt')

    // Undo puts the box back where it was.
    await undo()
    await waitFor(async () => {
      const row = await blockRepo.get(created.id)
      expect(row).toMatchObject({ y: 144, width: 300 })
    })
  })

  it('refuses invalid geometry instead of persisting it', async () => {
    const page = await pageRepo.upsert({ projectId: PROJECT_ID, index: 0 })
    const created = await blockRepo.upsert({
      projectId: PROJECT_ID,
      pageId: page.id,
      order: 0,
      kind: 'paragraph',
      sourceText: 'Hello',
      translatedText: TRANSLATION,
      x: 72,
      y: 144,
      width: 300,
      height: 40,
    })
    const blocks = await loadEditorBlocks(PROJECT_ID)
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <BlockInspector projectId={PROJECT_ID} block={blocks[0]} blocks={blocks} />
        </MemoryRouter>
      </I18nextProvider>,
    )

    // A box narrower than 1pt is rejected…
    fireEvent.change(await screen.findByTestId('geom-width'), { target: { value: '0' } })
    expect(await screen.findByTestId('geom-invalid')).toBeInTheDocument()
    expect(screen.getByTestId('geom-save')).toBeDisabled()

    // …and so is a negative page offset.
    fireEvent.change(screen.getByTestId('geom-width'), { target: { value: '300' } })
    fireEvent.change(screen.getByTestId('geom-x'), { target: { value: '-5' } })
    expect(screen.getByTestId('geom-invalid')).toBeInTheDocument()
    expect(screen.getByTestId('geom-save')).toBeDisabled()

    // Nothing invalid ever reached Dexie.
    const row = await blockRepo.get(created.id)
    expect(row).toMatchObject({ x: 72, width: 300 })
  })
})
