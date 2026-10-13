/**
 * Workspace editor integration test: the glue between the persisted document
 * and the split view.
 *
 * IndexedDB is faked exactly the way `BlockInspector.test.tsx` does it, and
 * `react-virtuoso` renders its items flat (see `SplitView.test.tsx` for why).
 * What is pinned here is the wiring that has no other test: gestures reaching
 * the store, an inline edit travelling through the command stack into Dexie
 * and back out again under undo, the keyboard shortcuts, and the session's
 * own lifecycle.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode, Ref } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { AppDatabase, setDb } from '@/db/db'
import { blockRepo, pageRepo } from '@/db/repo-content'
import { projectRepo } from '@/db/repo-projects'
import { collectExportDocument } from '@/export/collect'
import { buildHtmlDocument, DEFAULT_HTML_OPTIONS } from '@/export/html'
import { useEditorStore, resetEditorStore } from '@/editor/store'
import { WorkspaceEditor } from './WorkspaceEditor'

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

const PROJECT_ID = 'prj_workspace_editor'
const SOURCE = 'Breaking news from the city'
const TRANSLATION = 'မြို့မှ နောက်ဆုံးရ သတင်းများ'

/** One page, two translated blocks — the smallest document worth opening. */
async function seed(): Promise<string[]> {
  const page = await pageRepo.upsert({ projectId: PROJECT_ID, index: 0, width: 612, height: 792 })
  const first = await blockRepo.upsert({
    projectId: PROJECT_ID,
    pageId: page.id,
    order: 0,
    sourceText: SOURCE,
    translatedText: TRANSLATION,
  })
  const second = await blockRepo.upsert({
    projectId: PROJECT_ID,
    pageId: page.id,
    order: 1,
    sourceText: 'The board met on Tuesday.',
    translatedText: '',
  })
  return [first.id, second.id]
}

function mount(projectId = PROJECT_ID): ReturnType<typeof render> {
  return render(
    <I18nextProvider i18n={i18n}>
      <WorkspaceEditor projectId={projectId} />
    </I18nextProvider>,
  )
}

/** The block node with this id, once the live query has settled. */
async function blockNode(container: HTMLElement, id: string): Promise<HTMLElement> {
  await waitFor(() => {
    expect(container.querySelector(`[data-block-id="${id}"]`)).not.toBeNull()
  })
  return container.querySelector(`[data-block-id="${id}"]`) as HTMLElement
}

describe('WorkspaceEditor', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-workspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
    resetEditorStore()
  })

  afterEach(() => {
    cleanup()
  })

  it('opens the session and renders the seeded page with its blocks', async () => {
    await seed()
    mount()

    expect(screen.getByTestId('workspace-editor')).toBeInTheDocument()
    // The live query settles asynchronously; the row is its first appearance.
    const row = await screen.findByTestId('page-row')
    expect(row).toHaveAttribute('data-page-index', '0')
    await waitFor(() => expect(screen.getAllByTestId('editor-block')).toHaveLength(2))
    expect(screen.getByText(TRANSLATION)).toBeInTheDocument()
    // The untranslated block falls back to its source.
    expect(screen.getByText('The board met on Tuesday.')).toBeInTheDocument()
    expect(useEditorStore.getState().projectId).toBe(PROJECT_ID)
  })

  it('selects a block on click, additively with ctrl', async () => {
    const [first, second] = await seed()
    const { container } = mount()

    fireEvent.click(await blockNode(container, first))
    expect(useEditorStore.getState().selection).toEqual([first])

    fireEvent.click(await blockNode(container, second), { ctrlKey: true })
    expect(useEditorStore.getState().selection).toEqual([first, second])
  })

  it('selects the visible page with Ctrl+A once the list reports it', async () => {
    await seed()
    mount()
    await waitFor(() => expect(useEditorStore.getState().activePage).toBe(0))

    fireEvent.keyDown(window, { key: 'a', ctrlKey: true })
    expect(useEditorStore.getState().selection).toHaveLength(2)
  })

  it('edits a block inline, saves it through the command stack, undoes back', async () => {
    const [first] = await seed()
    const { container } = mount()

    fireEvent.dblClick(await blockNode(container, first))
    const editor = await screen.findByTestId('block-editor')
    editor.textContent = 'edited through the workspace'
    fireEvent.blur(editor)

    await waitFor(async () => {
      const record = await blockRepo.get(first)
      expect(record?.translatedText).toBe('edited through the workspace')
      // Editor-side half of the late-response guard (task 4.3): a manual edit
      // marks the block `edited`, which is exactly the state `persistLines`
      // skips — a translation response that lands afterwards can never
      // overwrite the user's text (that skip is pinned in resume.test.ts).
      expect(record?.status).toBe('edited')
    })
    // The commit continues after the block write — history rows, then the
    // stack — so the stack is awaited the same way the write was.
    await waitFor(() => expect(useEditorStore.getState().undoStack).toHaveLength(1))

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true })
    await waitFor(async () => {
      const record = await blockRepo.get(first)
      expect(record?.translatedText).toBe(TRANSLATION)
    })
  })

  it('opens find with Ctrl+F', async () => {
    await seed()
    mount()
    await screen.findAllByTestId('editor-block')

    expect(useEditorStore.getState().findOpen).toBe(false)
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    expect(useEditorStore.getState().findOpen).toBe(true)
    expect(await screen.findByRole('search')).toBeInTheDocument()
  })

  it('zooms with the keyboard and resets on zero', async () => {
    await seed()
    mount()
    await screen.findAllByTestId('editor-block')
    const start = useEditorStore.getState().zoom

    fireEvent.keyDown(window, { key: '=', ctrlKey: true })
    expect(useEditorStore.getState().zoom).toBeGreaterThan(start)

    fireEvent.keyDown(window, { key: '0', ctrlKey: true })
    expect(useEditorStore.getState().zoom).toBe(1)
  })

  it('ends the session on unmount', async () => {
    const [first] = await seed()
    const view = mount()
    fireEvent.click(await blockNode(view.container, first))
    expect(useEditorStore.getState().selection).toEqual([first])

    view.unmount()
    expect(useEditorStore.getState().selection).toEqual([])
    expect(useEditorStore.getState().projectId).toBeNull()
  })

  /**
   * Task 4.2 — the round trip: an edit made in the UI (text inline, size via
   * the toolbar) survives a navigation (unmount + remount) and is present in
   * the exported artifact, not just in the preview.
   */
  it('round-trips text and font size through a remount into the exported HTML', async () => {
    const project = await projectRepo.create({
      name: 'Round trip',
      sourceLang: 'en',
      targetLang: 'my',
    })
    const page = await pageRepo.upsert({
      projectId: project.id,
      index: 0,
      width: 612,
      height: 792,
    })
    const block = await blockRepo.upsert({
      projectId: project.id,
      pageId: page.id,
      order: 0,
      sourceText: SOURCE,
      translatedText: TRANSLATION,
      x: 72,
      y: 90,
      width: 468,
      height: 40,
    })

    // 1. Inline text edit — committed through the command stack on blur.
    const view = mount(project.id)
    fireEvent.dblClick(await blockNode(view.container, block.id))
    const editor = await screen.findByTestId('block-editor')
    editor.textContent = 'edited through the workspace'
    fireEvent.blur(editor)
    await waitFor(async () => {
      const row = await blockRepo.get(block.id)
      expect(row?.translatedText).toBe('edited through the workspace')
      expect(row?.status).toBe('edited')
    })

    // 2. Font size through the toolbar dropdown (select → apply → Dexie).
    fireEvent.click(await blockNode(view.container, block.id))
    fireEvent.click(screen.getByTestId('font-size'))
    fireEvent.click(await screen.findByRole('menuitem', { name: '14 pt' }))
    await waitFor(async () => {
      const row = await blockRepo.get(block.id)
      expect(row?.fontSize).toBe(14)
      expect(row?.fontSizeMode).toBe('custom')
    })

    // 3. Navigate away and back: nothing about the edit lived only in
    //    component state.
    view.unmount()
    const back = mount(project.id)
    expect(await screen.findByText('edited through the workspace')).toBeInTheDocument()
    back.unmount()

    // 4. The exported artifact carries the same edits (collect is the exact
    //    projection the export worker consumes; buildHtmlDocument is the
    //    html/pdf print source).
    const doc = await collectExportDocument({ projectId: project.id })
    const exported = doc.pages[0].blocks.find((entry) => entry.id === block.id)
    expect(exported).toMatchObject({
      translatedText: 'edited through the workspace',
      fontSize: 14,
      x: 72,
      y: 90,
      width: 468,
    })
    const html = buildHtmlDocument(doc, { ...DEFAULT_HTML_OPTIONS, title: project.name })
    expect(html).toContain('edited through the workspace')
    expect(html).toContain('font-size:14pt')
    expect(html).toContain('left:72pt;top:90pt;width:468pt')
  })

  /**
   * Task 4.4 — the keyboard guard: document shortcuts must not fire while a
   * person is typing (Ctrl+Z inside the inline editor is the browser's text
   * undo, not the document undo).
   *
   * jsdom does not implement `isContentEditable` on any element, so the
   * platform property is stubbed here — the handler line under test is the
   * real one the browser executes.
   */
  it('leaves Ctrl+Z to the browser while typing in the inline editor', async () => {
    const [first] = await seed()
    const { container } = mount()

    // One committed edit, so the document undo stack is non-empty.
    fireEvent.dblClick(await blockNode(container, first))
    const firstEditor = await screen.findByTestId('block-editor')
    firstEditor.textContent = 'first edit'
    fireEvent.blur(firstEditor)
    await waitFor(async () => {
      expect((await blockRepo.get(first))?.translatedText).toBe('first edit')
      expect(useEditorStore.getState().undoStack).toHaveLength(1)
    })

    // Start a second edit and press Ctrl+Z mid-typing.
    fireEvent.dblClick(await blockNode(container, first))
    const editor = await screen.findByTestId('block-editor')
    editor.textContent = 'second edit in progress'
    Object.defineProperty(editor, 'isContentEditable', { value: true })
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true })

    // The guard returned before the switch: the stack still holds exactly the
    // first command, and the committed text is untouched.
    expect(useEditorStore.getState().undoStack).toHaveLength(1)
    await waitFor(async () => {
      expect((await blockRepo.get(first))?.translatedText).toBe('first edit')
    })
  })

  /**
   * Task 4.4 — overflow warning: a block whose text measures outside its box
   * raises the toolbar badge (measured with jsdom's metric-free 0.52em
   * fallback, so the numbers below are deterministic).
   */
  it('shows the overflow badge for blocks that measure outside their box', async () => {
    const page = await pageRepo.upsert({
      projectId: PROJECT_ID,
      index: 0,
      width: 612,
      height: 792,
    })
    // 12pt Myanmar text wraps to 2 lines → 36pt tall inside a 10pt box.
    const narrow = await blockRepo.upsert({
      projectId: PROJECT_ID,
      pageId: page.id,
      order: 0,
      sourceText: SOURCE,
      translatedText: TRANSLATION,
      x: 72,
      y: 72,
      width: 100,
      height: 10,
    })
    // The same text fits comfortably in a 468 × 120 box.
    await blockRepo.upsert({
      projectId: PROJECT_ID,
      pageId: page.id,
      order: 1,
      sourceText: SOURCE,
      translatedText: TRANSLATION,
      x: 72,
      y: 120,
      width: 468,
      height: 120,
    })
    mount()
    await screen.findAllByTestId('editor-block')

    await waitFor(
      () => {
        expect(screen.getByTestId('overflow-count')).toBeInTheDocument()
        expect(useEditorStore.getState().overflowIds).toEqual([narrow.id])
      },
      { timeout: 4000 },
    )
  })
})
