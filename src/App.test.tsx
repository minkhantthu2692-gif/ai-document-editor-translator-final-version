/**
 * First-run routing — the landing page a fresh install must show: `/` sends an
 * un-onboarded profile to the welcome + first-time setup screen, and hands an
 * already-onboarded profile straight to the app (deep links are never gated,
 * only `/` is — see the doc comments in `App.tsx`).
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter, useLocation } from 'react-router-dom'
import i18n from '@/i18n'
import { useUiStore } from '@/stores/uiStore'
import { App } from './App'

/** Reports the router's current path so route hand-offs are observable. */
function PathProbe() {
  const location = useLocation()
  return <div data-testid="path-probe">{location.pathname}</div>
}

function renderAt(path: string): ReturnType<typeof render> {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[path]}>
        <App />
        <PathProbe />
      </MemoryRouter>
    </I18nextProvider>,
  )
}

describe('App first-run routing', () => {
  beforeEach(async () => {
    localStorage.clear()
    useUiStore.setState({ onboarded: false })
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    cleanup()
    useUiStore.setState({ onboarded: false })
    localStorage.clear()
  })

  it('sends a fresh profile from / to the landing + first-time setup screen', async () => {
    renderAt('/')

    expect(await screen.findByTestId('welcome-get-started')).toBeInTheDocument()
    expect(screen.getByTestId('path-probe')).toHaveTextContent('/welcome')
    expect(screen.getByText(String(i18n.t('welcome.headline')))).toBeInTheDocument()
  })

  it('hands an already-onboarded profile straight to the app', async () => {
    useUiStore.setState({ onboarded: true })

    renderAt('/welcome')

    // The welcome route bounces back into the app: no setup screen, and the
    // router settles on the index route.
    expect(screen.queryByTestId('welcome-get-started')).not.toBeInTheDocument()
    expect(await screen.findByTestId('path-probe')).toHaveTextContent('/')
  })
})
