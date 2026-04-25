import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

describe('App grid points', () => {
  afterEach(() => {
    cleanup()
  })

  it('starts at the default grid size and allows inline editing', async () => {
    const user = userEvent.setup()

    render(<App />)

    const valueButton = screen.getByLabelText('Edit grid points')
    expect(valueButton.textContent).toBe('512')

    await user.dblClick(valueButton)
    const input = screen.getByLabelText('Grid points')
    await user.clear(input)
    await user.type(input, '256{Enter}')

    expect(screen.getByLabelText('Edit grid points').textContent).toBe('256')
  })

  it('syncs grid points to the imported csv point count', async () => {
    render(<App />)

    const csvInput = document.querySelector(
      'input[type="file"][accept=".csv,text/csv"]',
    )

    expect(csvInput).toBeTruthy()

    const file = new File(
      ['frequency,gain\n20,-3\n1000,0\n20000,2.5'],
      'baseline.csv',
      { type: 'text/csv' },
    )

    fireEvent.change(csvInput as Element, {
      target: { files: [file] },
    })

    await waitFor(() => {
      expect(screen.getByLabelText('Edit grid points').textContent).toBe('3')
    })
  })
})

describe('App monitor controls', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders monitor toggle controls and removes the standalone upload button', () => {
    render(<App />)

    expect(screen.getByRole('button', { name: 'Baseline monitor' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Monitor bypass' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Upload audio' })).toBeNull()
  })

  it('opens audio file input when monitor title card is clicked', async () => {
    const user = userEvent.setup()

    render(<App />)

    const audioInput = document.querySelector(
      'input[type="file"][accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac"]',
    ) as HTMLInputElement | null

    expect(audioInput).toBeTruthy()

    const clickSpy = vi.spyOn(audioInput as HTMLInputElement, 'click')

    await user.click(screen.getByRole('button', { name: 'Upload monitor audio' }))

    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('renders custom monitor player controls instead of native audio controls', () => {
    render(<App />)

    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy()
    expect(screen.getByLabelText('Monitor position')).toBeTruthy()
    expect(screen.getByLabelText('Monitor volume')).toBeTruthy()
    expect(document.querySelector('audio[controls]')).toBeNull()
  })
})
