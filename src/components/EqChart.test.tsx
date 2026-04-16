import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EqChart, getSpectrumDisplayLevelDb } from './EqChart'
import { createFlatCurve } from '../lib/curve'
import type { EqBand, FftOverlay } from '../types'

const baselineCurve = createFlatCurve([20, 1000, 20000])
const fftOverlay: FftOverlay = {
  preSpectrum: [
    { frequencyHz: 20, levelDb: -60 },
    { frequencyHz: 1000, levelDb: -36 },
    { frequencyHz: 20000, levelDb: -54 },
  ],
  postSpectrum: [
    { frequencyHz: 20, levelDb: -54 },
    { frequencyHz: 1000, levelDb: -34 },
    { frequencyHz: 20000, levelDb: -54.2 },
  ],
}

function renderChart(
  overrides: Partial<React.ComponentProps<typeof EqChart>> = {},
) {
  return render(
    <EqChart
      baselineCurve={baselineCurve}
      bandCurve={createFlatCurve([20, 1000, 20000])}
      outputCurve={baselineCurve}
      bands={[]}
      visualGainDb={30}
      showFlatHint
      viewMinDb={-15}
      viewMaxDb={15}
      onBandCommit={vi.fn()}
      onBandCreate={vi.fn()}
      onBandDelete={vi.fn()}
      onBandToggleBypass={vi.fn()}
      onBandSelect={vi.fn()}
      onIncreaseViewMax={vi.fn()}
      onDecreaseViewMax={vi.fn()}
      onIncreaseViewMin={vi.fn()}
      onDecreaseViewMin={vi.fn()}
      {...overrides}
    />,
  )
}

describe('EqChart', () => {
  beforeEach(() => {
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 1200,
      height: 700,
      top: 0,
      left: 0,
      right: 1200,
      bottom: 700,
      toJSON: () => ({}),
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('creates a peaking band when the chart is double-clicked', async () => {
    const user = userEvent.setup()
    const onBandCreate = vi.fn()

    renderChart({ onBandCreate })

    await user.dblClick(screen.getByLabelText('EQ editing surface'))

    expect(onBandCreate).toHaveBeenCalledTimes(1)
    expect(onBandCreate.mock.calls[0][0]).toMatchObject({
      type: 'peaking',
      q: 1,
    })
  })

  it('shows a hover popover and removes the band on node double-click', async () => {
    const user = userEvent.setup()
    const onBandDelete = vi.fn()
    const band: EqBand = {
      id: 'band-1',
      type: 'peaking',
      frequencyHz: 1000,
      isBypassed: false,
      gainDb: 3,
      q: 1.1,
      slopeDbPerOct: 12,
    }

    renderChart({
      bands: [band],
      selectedBandId: band.id,
      showFlatHint: false,
      onBandDelete,
    })

    await user.hover(screen.getByLabelText('Bell band'))
    expect(screen.getByText('Selected node')).toBeTruthy()

    await user.dblClick(screen.getByLabelText('Bell band'))
    expect(onBandDelete).toHaveBeenCalledWith('band-1')
  })

  it('allows double-click editing of popup values', async () => {
    const user = userEvent.setup()
    const onBandCommit = vi.fn()
    const band: EqBand = {
      id: 'band-1',
      type: 'peaking',
      frequencyHz: 1000,
      isBypassed: false,
      gainDb: 3,
      q: 1.1,
      slopeDbPerOct: 12,
    }

    const { container } = renderChart({
      bands: [band],
      selectedBandId: band.id,
      showFlatHint: false,
      onBandCommit,
    })

    const chart = within(container)
    await user.click(chart.getByLabelText('Bell band'))
    await user.dblClick(chart.getByLabelText('Edit frequency'))
    const input = chart.getByLabelText('Frequency')
    await user.clear(input)
    await user.type(input, '1500{Enter}')

    expect(onBandCommit).toHaveBeenLastCalledWith({
      ...band,
      frequencyHz: 1500,
    }, 'immediate')
  })

  it('adjusts Q with the mouse wheel while dragging a peaking band', () => {
    const onBandCommit = vi.fn()
    const band: EqBand = {
      id: 'band-1',
      type: 'peaking',
      frequencyHz: 1000,
      isBypassed: false,
      gainDb: 3,
      q: 1.1,
      slopeDbPerOct: 12,
    }

    const { container } = renderChart({
      bands: [band],
      selectedBandId: band.id,
      showFlatHint: false,
      onBandCommit,
    })

    const chart = within(container)
    const node = chart.getByLabelText('Bell band')
    const chartFrame = container.querySelector('.chart-frame')

    expect(chartFrame).toBeTruthy()

    fireEvent.pointerDown(node, {
      pointerId: 1,
      clientX: 600,
      clientY: 350,
    })
    onBandCommit.mockClear()

    fireEvent.wheel(chartFrame as Element, { deltaY: -100 })

    expect(onBandCommit).toHaveBeenCalledWith({
      ...band,
      q: 1.15,
    }, 'immediate')

    fireEvent.pointerUp(node, { pointerId: 1 })
    expect(onBandCommit).toHaveBeenLastCalledWith(band, 'immediate')
    onBandCommit.mockClear()
    fireEvent.wheel(chartFrame as Element, { deltaY: -100 })
    expect(onBandCommit).not.toHaveBeenCalled()
  })

  it('marks pointer drag updates as smooth', () => {
    const onBandCommit = vi.fn()
    const band: EqBand = {
      id: 'band-1',
      type: 'peaking',
      frequencyHz: 1000,
      isBypassed: false,
      gainDb: 3,
      q: 1.1,
      slopeDbPerOct: 12,
    }

    renderChart({
      bands: [band],
      selectedBandId: band.id,
      showFlatHint: false,
      onBandCommit,
    })

    const node = screen.getByLabelText('Bell band')
    fireEvent.pointerDown(node, {
      pointerId: 1,
      clientX: 600,
      clientY: 350,
    })
    onBandCommit.mockClear()

    fireEvent.pointerMove(node, {
      pointerId: 1,
      clientX: 650,
      clientY: 320,
    })

    expect(onBandCommit).toHaveBeenCalledTimes(1)
    expect(onBandCommit.mock.calls[0][1]).toBe('smooth')
  })

  it('adjusts shelf slope with the mouse wheel while dragging', () => {
    const onBandCommit = vi.fn()
    const band: EqBand = {
      id: 'band-1',
      type: 'lowShelf',
      frequencyHz: 180,
      isBypassed: false,
      gainDb: 4,
      slopeDbPerOct: 12,
    }

    const { container } = renderChart({
      bands: [band],
      selectedBandId: band.id,
      showFlatHint: false,
      onBandCommit,
    })

    const chart = within(container)
    const node = chart.getByLabelText('Low shelf band')
    const chartFrame = container.querySelector('.chart-frame')

    expect(chartFrame).toBeTruthy()

    fireEvent.pointerDown(node, {
      pointerId: 1,
      clientX: 600,
      clientY: 350,
    })
    onBandCommit.mockClear()

    fireEvent.wheel(chartFrame as Element, { deltaY: -100 })

    expect(onBandCommit).toHaveBeenCalledWith({
      ...band,
      slopeDbPerOct: 18,
    }, 'immediate')
  })

  it('adjusts cut slope with the mouse wheel while dragging', () => {
    const onBandCommit = vi.fn()
    const band: EqBand = {
      id: 'band-1',
      type: 'lowCut',
      frequencyHz: 120,
      isBypassed: false,
      slopeDbPerOct: 24,
    }

    const { container } = renderChart({
      bands: [band],
      selectedBandId: band.id,
      showFlatHint: false,
      onBandCommit,
    })

    const chart = within(container)
    const node = chart.getByLabelText('Low cut band')
    const chartFrame = container.querySelector('.chart-frame')

    expect(chartFrame).toBeTruthy()

    fireEvent.pointerDown(node, {
      pointerId: 1,
      clientX: 600,
      clientY: 350,
    })
    onBandCommit.mockClear()

    fireEvent.wheel(chartFrame as Element, { deltaY: -100 })

    expect(onBandCommit).toHaveBeenCalledWith({
      ...band,
      slopeDbPerOct: 36,
    }, 'immediate')
  })

  it('toggles band bypass from the popover', async () => {
    const user = userEvent.setup()
    const onBandToggleBypass = vi.fn()
    const band: EqBand = {
      id: 'band-1',
      type: 'peaking',
      frequencyHz: 1000,
      isBypassed: true,
      gainDb: 3,
      q: 1.1,
      slopeDbPerOct: 12,
    }

    renderChart({
      bands: [band],
      selectedBandId: band.id,
      showFlatHint: false,
      onBandToggleBypass,
    })

    await user.click(screen.getByLabelText('Bell band'))
    await user.click(screen.getByRole('button', { name: 'Bypassed' }))
    expect(onBandToggleBypass).toHaveBeenCalledWith('band-1')
  })

  it('closes the popover after dragging when the pointer leaves', () => {
    vi.useFakeTimers()
    const band: EqBand = {
      id: 'band-1',
      type: 'peaking',
      frequencyHz: 1000,
      isBypassed: false,
      gainDb: 3,
      q: 1.1,
      slopeDbPerOct: 12,
    }

    renderChart({
      bands: [band],
      showFlatHint: false,
    })

    const node = screen.getByLabelText('Bell band')
    fireEvent.pointerDown(node, {
      pointerId: 1,
      clientX: 600,
      clientY: 350,
    })
    expect(screen.getByText('Selected node')).toBeTruthy()

    fireEvent.pointerUp(node, { pointerId: 1 })
    fireEvent.mouseLeave(node)
    act(() => {
      vi.advanceTimersByTime(150)
    })

    expect(screen.queryByText('Selected node')).toBeNull()
  })

  it('calls the view bound controls independently', async () => {
    const user = userEvent.setup()
    const onIncreaseViewMax = vi.fn()
    const onDecreaseViewMin = vi.fn()

    renderChart({ onIncreaseViewMax, onDecreaseViewMin })

    const buttons = screen.getAllByRole('button', { name: /^[+-]$/ })
    await user.click(buttons[0])
    await user.click(buttons[2])

    expect(onIncreaseViewMax).toHaveBeenCalledTimes(1)
    expect(onDecreaseViewMin).toHaveBeenCalledTimes(1)
  })

  it('renders FFT overlay layers when spectrum data is available', () => {
    renderChart({ fftOverlay, showFlatHint: false })

    expect(screen.getByTestId('fft-pre-fill')).toBeTruthy()
    expect(screen.getByTestId('fft-pre-line')).toBeTruthy()
    expect(screen.getAllByTestId('fft-post-segment').length).toBeGreaterThanOrEqual(2)
  })

  it('applies +3 dB per octave display compensation around 1 kHz', () => {
    expect(getSpectrumDisplayLevelDb(-30, 1000)).toBe(-30)
    expect(getSpectrumDisplayLevelDb(-30, 2000)).toBeCloseTo(-27)
    expect(getSpectrumDisplayLevelDb(-30, 500)).toBeCloseTo(-33)
  })

  it('adds visual gain on top of the display compensation only', () => {
    expect(getSpectrumDisplayLevelDb(-30, 1000, 30)).toBe(0)
    expect(getSpectrumDisplayLevelDb(-30, 2000, 30)).toBeCloseTo(3)
  })

  it('renders the FFT pre-line as a smoothed sampled path', () => {
    renderChart({ fftOverlay, showFlatHint: false })

    const path = screen.getByTestId('fft-pre-line')
    const commands = path.getAttribute('d')?.match(/[ML]/g) ?? []
    expect(commands.length).toBeGreaterThan(3)
  })

  it('hides yellow FFT segments when post and pre responses are nearly identical', () => {
    renderChart({
      fftOverlay: {
        preSpectrum: fftOverlay.preSpectrum,
        postSpectrum: [
          { frequencyHz: 20, levelDb: -60.1 },
          { frequencyHz: 1000, levelDb: -35.7 },
          { frequencyHz: 20000, levelDb: -54.2 },
        ],
      },
      showFlatHint: false,
    })

    expect(screen.queryByTestId('fft-post-segment')).toBeNull()
  })

  it('moves the FFT display upward when visual gain increases', () => {
    const { rerender } = renderChart({ fftOverlay, showFlatHint: false, visualGainDb: 0 })
    const lowGainPath = screen.getByTestId('fft-pre-line').getAttribute('d')

    rerender(
      <EqChart
        baselineCurve={baselineCurve}
        bandCurve={createFlatCurve([20, 1000, 20000])}
        outputCurve={baselineCurve}
        bands={[]}
        visualGainDb={30}
        showFlatHint={false}
        viewMinDb={-15}
        viewMaxDb={15}
        onBandCommit={vi.fn()}
        onBandCreate={vi.fn()}
        onBandDelete={vi.fn()}
        onBandToggleBypass={vi.fn()}
        onBandSelect={vi.fn()}
        onIncreaseViewMax={vi.fn()}
        onDecreaseViewMax={vi.fn()}
        onIncreaseViewMin={vi.fn()}
        onDecreaseViewMin={vi.fn()}
        fftOverlay={fftOverlay}
      />,
    )

    const highGainPath = screen.getByTestId('fft-pre-line').getAttribute('d')
    expect(highGainPath).not.toEqual(lowGainPath)
  })
})


