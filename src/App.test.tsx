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

function importMonitorAudio() {
  const audioInput = document.querySelector(
    'input[type="file"][accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac"]',
  )
  expect(audioInput).toBeTruthy()

  const file = new File(['audio'], 'monitor.mp3', { type: 'audio/mpeg' })

  fireEvent.change(audioInput as Element, {
    target: { files: [file] },
  })
}

describe('App', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:monitor-audio'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
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
    expect(screen.getByRole('dialog', { name: 'Choose export format' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Export' }))
    await waitFor(() => {
      expect(screen.getByText('Output EQ curve exported as CSV.')).toBeTruthy()
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

  it('uses custom monitor controls for the monitor player', () => {
    render(<App />)

    const audio = document.querySelector('audio.monitor-player')

    expect(audio).toBeTruthy()
    expect(audio?.hasAttribute('controls')).toBe(false)
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy()
    expect(screen.getByLabelText('Monitor position')).toBeTruthy()
    expect(screen.getByLabelText('Monitor volume')).toBeTruthy()
  })

  it('plays through the custom monitor button', async () => {
    const user = userEvent.setup()
    const playSpy = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockResolvedValue(undefined)

    render(<App />)
    importMonitorAudio()

    await user.click(screen.getByRole('button', { name: 'Play' }))

    expect(playSpy).toHaveBeenCalledTimes(1)
  })

  it('commits custom monitor seek changes to audio currentTime', () => {
    render(<App />)
    importMonitorAudio()

    const audio = document.querySelector('audio.monitor-player') as HTMLAudioElement
    Object.defineProperty(audio, 'duration', {
      configurable: true,
      value: 120,
    })
    fireEvent(audio, new Event('durationchange'))

    const position = screen.getByLabelText('Monitor position')
    fireEvent.change(position, { target: { value: '500' } })
    fireEvent.mouseUp(position)

    expect(audio.currentTime).toBe(60)
  })

  it('shows zero monitor time when duration is unavailable', () => {
    render(<App />)
    importMonitorAudio()

    const audio = document.querySelector('audio.monitor-player') as HTMLAudioElement
    Object.defineProperty(audio, 'duration', {
      configurable: true,
      value: Number.NaN,
    })
    audio.currentTime = 12
    fireEvent(audio, new Event('durationchange'))
    fireEvent(audio, new Event('timeupdate'))

    expect(screen.queryByText('00:00 / 00:00')).toBeNull()
    expect(screen.getByText('00:00')).toBeTruthy()
  })

  it('updates custom monitor volume and mute state', async () => {
    const user = userEvent.setup()

    render(<App />)
    importMonitorAudio()

    const audio = document.querySelector('audio.monitor-player') as HTMLAudioElement
    const volumeSlider = screen.getByLabelText('Monitor volume')

    fireEvent.change(volumeSlider, { target: { value: '0.4' } })
    expect(audio.volume).toBe(0.4)
    expect(audio.muted).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Mute' }))
    expect(audio.muted).toBe(true)
  })
})
