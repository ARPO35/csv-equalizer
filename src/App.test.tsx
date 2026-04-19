import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

describe('App grid points', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
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

    expect(
      await screen.findByText('Loaded baseline EQ from baseline.csv.'),
    ).toBeTruthy()
    expect(screen.getByLabelText('Edit grid points').textContent).toBe('3')
  })

  it('does not re-register keydown listeners after rerenders', async () => {
    const user = userEvent.setup()
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')

    render(<App />)

    expect(
      addEventListenerSpy.mock.calls.filter(([type]) => type === 'keydown'),
    ).toHaveLength(2)

    const valueButton = screen.getByLabelText('Edit grid points')
    await user.dblClick(valueButton)
    const input = screen.getByLabelText('Grid points')
    await user.clear(input)
    await user.type(input, '768{Enter}')

    expect(screen.getByLabelText('Edit grid points').textContent).toBe('768')
    expect(
      addEventListenerSpy.mock.calls.filter(([type]) => type === 'keydown'),
    ).toHaveLength(2)
    expect(
      removeEventListenerSpy.mock.calls.filter(([type]) => type === 'keydown'),
    ).toHaveLength(0)
  })
})
