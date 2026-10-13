/**
 * Settings → Data tab, danger zone: "Delete all local data?" must be a full
 * first-run reset, not just a database delete. The wipe clears the Dexie
 * database *and* the localStorage keys (`aidt.ui` — which carries the
 * `onboarded` flag — and `aidt.deviceId`), so the next load starts at the
 * landing/first-time-setup screen like a fresh install.
 *
 * The storage half runs against fake-indexeddb + jsdom's localStorage. The
 * `/welcome` hand-off cannot be observed here — jsdom's `location.replace`
 * is unforgeable and navigation is not implemented — so it is verified end
 * to end in `scripts/smoke.mjs` (real browser).
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { AppDatabase, setDb } from '@/db/db'
import { DataTab } from './DataTab'

/** Resolves an i18n key whether or not the locales carry it yet. */
function label(key: string): string {
  return String(i18n.t(key))
}

function renderTab() {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/settings?tab=data']}>
        <DataTab />
      </MemoryRouter>
    </I18nextProvider>,
  )
}

describe('DataTab delete-all', () => {
  let db: AppDatabase

  beforeEach(async () => {
    db = new AppDatabase(`aidt-datatab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    setDb(db)
    await db.open()
    await i18n.changeLanguage('en')
    localStorage.clear()
    // A profile that has been onboarded — exactly what the wipe must undo.
    localStorage.setItem(
      'aidt.ui',
      JSON.stringify({ state: { onboarded: true, theme: 'dark', language: 'en' }, version: 1 }),
    )
    localStorage.setItem('aidt.deviceId', 'device_test')
  })

  afterEach(() => {
    cleanup()
    setDb(null)
    localStorage.clear()
  })

  it('clears the database and the localStorage first-run keys', async () => {
    renderTab()

    fireEvent.click(screen.getByTestId('delete-local'))
    const confirm = await screen.findByRole('button', {
      name: label('settings.data.deleteAllConfirm'),
    })
    fireEvent.click(confirm)

    // The wipe itself: the persisted first-run/UI keys go with the database —
    // this is what used to be left behind (`aidt.ui` kept `onboarded: true`,
    // so a reload put the user straight back into the app instead of the
    // welcome screen). The /welcome hand-off itself cannot be observed in
    // jsdom (location.replace is unforgeable); smoke.mjs verifies it end to
    // end in a real browser.
    await waitFor(() => expect(localStorage.getItem('aidt.ui')).toBeNull())
    expect(localStorage.getItem('aidt.deviceId')).toBeNull()
  })
})
