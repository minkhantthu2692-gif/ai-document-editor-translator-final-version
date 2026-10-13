/**
 * In-flight guard (Phase 5.2, finding L-08): a rapid double activation of the
 * run controls used to fire a second `startTranslate`, whose empty-plan
 * outcome could cancel the first call mid-flight.
 *
 * The queue is mocked at the module boundary — these tests pin the UI's
 * behaviour (one call per activation burst, honest disabled state while it is
 * pending), never a real translation.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import i18n from '@/i18n'
import { AppDatabase, setDb } from '@/db/db'
import { apiKeyRepo } from '@/db/repo-apiKeys'
import { projectRepo } from '@/db/repo-projects'
import { startTranslate } from '@/translate/translateQueue'
import type { StartOutcome } from '@/translate/translateQueue'
import { TranslatePage } from './TranslatePage'

vi.mock('@/translate/translateQueue', () => ({
  startTranslate: vi.fn(),
  restoreTranslate: vi.fn(async () => 0),
  subscribeTranslate: vi.fn(() => () => {}),
  pauseTranslate: vi.fn(),
  cancelTranslate: vi.fn(),
  tryNowTranslate: vi.fn(),
}))

function renderAt(path: string): ReturnType<typeof render> {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/translate/:projectId" element={<TranslatePage />} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  )
}

describe('TranslatePage run guard', () => {
  let db: AppDatabase

  beforeEach(async () => {
    vi.mocked(startTranslate).mockReset()
    db = new AppDatabase(
      `aidt-translatepage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    )
    setDb(db)
    await db.open()
  })

  afterEach(() => {
    cleanup()
  })

  it('fires one startTranslate for a rapid double activation and disables Start while it is pending', async () => {
    const project = await projectRepo.create({
      name: 'Run guard',
      sourceLang: 'en',
      targetLang: 'my',
    })
    await apiKeyRepo.create({
      provider: 'gemini',
      label: 'Main',
      secret: 'gsk_test_secret_value',
    })

    const outcome = (pending: number): StartOutcome => ({
      total: pending,
      pending,
      alreadyDone: 0,
      skipped: 0,
      sessionId: `ses_${Math.random().toString(36).slice(2, 8)}`,
    })

    let settle!: (value: StartOutcome) => void
    vi.mocked(startTranslate).mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        }),
    )

    renderAt(`/translate/${project.id}`)

    // The page derives its config asynchronously (settings + imported models),
    // so the Start button only becomes actionable after that settles.
    const start = await screen.findByTestId('status-start', {}, { timeout: 4000 })
    await waitFor(() => expect(start).toBeEnabled())

    fireEvent.click(start)
    fireEvent.click(start) // rapid double activation (L-08)

    expect(startTranslate).toHaveBeenCalledTimes(1)
    // Requirement 8: the disabled state tells the truth while the start is
    // still in flight, instead of a control that looks pressable.
    expect(start).toBeDisabled()

    settle(outcome(3))
    await waitFor(() => expect(start).toBeEnabled())
    expect(startTranslate).toHaveBeenCalledTimes(1)
  })

  it('lets a fresh activation through once the previous start has settled', async () => {
    const project = await projectRepo.create({
      name: 'Sequential runs',
      sourceLang: 'en',
      targetLang: 'my',
    })
    await apiKeyRepo.create({
      provider: 'gemini',
      label: 'Main',
      secret: 'gsk_test_secret_value',
    })

    vi.mocked(startTranslate).mockResolvedValue({
      total: 2,
      pending: 2,
      alreadyDone: 0,
      skipped: 0,
      sessionId: 'ses_sequential',
    })

    renderAt(`/translate/${project.id}`)

    const start = await screen.findByTestId('status-start', {}, { timeout: 4000 })
    await waitFor(() => expect(start).toBeEnabled())

    fireEvent.click(start)
    await waitFor(() => expect(startTranslate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(start).toBeEnabled())

    fireEvent.click(start)
    await waitFor(() => expect(startTranslate).toHaveBeenCalledTimes(2))
  })
})
