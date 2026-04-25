import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FftOverlayStore } from './lib/audio-monitor'

const { monitorState, fftStore } = vi.hoisted(() => {
  const mockedFftStore: FftOverlayStore = {
    getSnapshot: () => ({
      version: 0,
      hasData: false,
      sampleRate: 0,
      frequencies: new Float32Array(0),
      preLevels: new Float32Array(0),
      postLevels: new Float32Array(0),
    }),
    subscribe: () => () => undefined,
  }

  return {
    monitorState: {
      errorMessage: null as string | null,
    },
    fftStore: mockedFftStore,
  }
})

vi.mock('./lib/audio-monitor', async () => {
  const actual = await vi.importActual<typeof import('./lib/audio-monitor')>(
    './lib/audio-monitor',
  )

  return {
    ...actual,
    useEqPlaybackMonitor: vi.fn(() => ({
      errorMessage: monitorState.errorMessage,
      fftStore,
      hasFftFrame: false,
    })),
  }
})

vi.mock('./lib/files', async () => {
  const actual = await vi.importActual<typeof import('./lib/files')>('./lib/files')
  return {
    ...actual,
    saveTextFile: vi.fn(),
  }
})

import App from './App'
import { saveTextFile } from './lib/files'

function importCsvBaseline() {
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
}

describe('App', () => {
  beforeEach(() => {
    monitorState.errorMessage = null
    vi.mocked(saveTextFile).mockReset()
    vi.mocked(saveTextFile).mockResolvedValue({
      handle: null,
      mode: 'picker',
    } as { handle: null; mode: 'picker' })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('starts at the default FFT size and allows inline editing', async () => {
    const user = userEvent.setup()

    render(<App />)

    const valueButton = screen.getByLabelText('Edit FFT size')
    expect(valueButton.textContent).toBe('8192')

    await user.dblClick(valueButton)
    const input = screen.getByLabelText('FFT size')
    await user.clear(input)
    await user.type(input, '256{Enter}')

    expect(screen.getByLabelText('Edit FFT size').textContent).toBe('256')
  })

  it('keeps FFT size unchanged when importing csv and emits import success toast', async () => {
    render(<App />)

    importCsvBaseline()

    await waitFor(() => {
      expect(screen.getByLabelText('Edit FFT size').textContent).toBe('8192')
    })

    expect(screen.getByText('Imported EQ CSV: baseline.csv')).toBeTruthy()
  })

  it('emits info toasts for save and export success', async () => {
    const user = userEvent.setup()
    render(<App />)

    importCsvBaseline()
    await waitFor(() => {
      expect(screen.getByText('Imported EQ CSV: baseline.csv')).toBeTruthy()
    })

    await user.click(screen.getByRole('button', { name: 'Save preset' }))
    await waitFor(() => {
      expect(screen.getByText('Preset saved successfully.')).toBeTruthy()
    })

    await user.click(screen.getByRole('button', { name: 'Export output' }))
    await waitFor(() => {
      expect(screen.getByText('Output EQ curve exported successfully.')).toBeTruthy()
    })
  })

  it('treats save AbortError as info and not as error', async () => {
    const user = userEvent.setup()
    vi.mocked(saveTextFile).mockRejectedValueOnce(
      new DOMException('The operation was aborted.', 'AbortError'),
    )

    render(<App />)
    importCsvBaseline()
    await waitFor(() => {
      expect(screen.getByText('Imported EQ CSV: baseline.csv')).toBeTruthy()
    })

    await user.click(screen.getByRole('button', { name: 'Save preset' }))
    const toast = await screen.findByText('Preset save cancelled by user.')
    const toastButton = toast.closest('button')

    expect(toastButton?.className).toContain('toast-level-info')
  })

  it('emits warning toast when save falls back to download mode', async () => {
    const user = userEvent.setup()
    vi.mocked(saveTextFile).mockResolvedValueOnce({
      handle: null,
      mode: 'download',
    } as { handle: null; mode: 'download' })

    render(<App />)
    importCsvBaseline()
    await waitFor(() => {
      expect(screen.getByText('Imported EQ CSV: baseline.csv')).toBeTruthy()
    })

    await user.click(screen.getByRole('button', { name: 'Save preset' }))
    const toast = await screen.findByText('Saved preset via browser download fallback.')
    const toastButton = toast.closest('button')

    expect(toastButton?.className).toContain('toast-level-warning')
  })

  it('emits monitor error toast and recovery warning toast', async () => {
    const view = render(<App />)

    monitorState.errorMessage = 'Monitor graph failed to initialize.'
    view.rerender(<App />)

    const errorToast = await screen.findByText('Monitor graph failed to initialize.')
    expect(errorToast.closest('button')?.className).toContain('toast-level-error')

    monitorState.errorMessage = null
    view.rerender(<App />)

    const recoveryToast = await screen.findByText('Monitor recovered from previous error.')
    expect(recoveryToast.closest('button')?.className).toContain('toast-level-warning')
    expect(screen.queryByText('Import status')).toBeNull()
    expect(screen.queryByText('Monitor status')).toBeNull()
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

  it('uses native audio controls for the monitor player', () => {
    render(<App />)

    expect(document.querySelector('audio.monitor-player[controls]')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Play' })).toBeNull()
    expect(screen.queryByLabelText('Monitor position')).toBeNull()
    expect(screen.queryByLabelText('Monitor volume')).toBeNull()
  })
})
