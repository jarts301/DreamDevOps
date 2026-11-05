import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import about from './about.json'
import App from './App.tsx'

describe('App', () => {
  it('shows the name of the app', () => {
    render(<App />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      about.name,
    )
  })

  it('offers something to click', () => {
    render(<App />)

    expect(screen.getByRole('button')).toBeEnabled()
  })
})
