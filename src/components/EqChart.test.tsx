import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EqChart, getSpectrumDisplayLevelDb } from './EqChart'
import { createFlatCurve } from '../lib/curve'
import type { FftOverlayStore } from '../lib/audio-monitor'
import type { EqBand } from '../types'

const baselineCurve = createFlatCurve([20, 1000, 20000])

function createFftStore(): FftOverlayStore {
  const frequencies = Float32Array.from([20, 1000, 20000])
  const preLevels = Float32Array.from([-60, -36, -54])
  const postLevels = Float32Array.from([-54, -34, -54.2])

  return {
    getSnapshot: () => ({
      version: 1,
      hasData: true,
      sampleRate: 48_000,
      frequencies,
      preLevels,
      postLevels,
    }),
    subscribe: () => () => undefined,
  }
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
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(performance.now())
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
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

    renderChart({
      bands: [band],
      selectedBandId: band.id,
      onBandCommit,
    })

    await user.click(screen.getByLabelText('Bell band'))
    await user.dblClick(screen.getByLabelText('Edit frequency'))
    const input = screen.getByLabelText('Frequency')
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
      q: 1.19,
    }, 'immediate')

    fireEvent.pointerUp(node, { pointerId: 1 })
    expect(onBandCommit.mock.calls.at(-1)?.[1]).toBe('immediate')
    onBandCommit.mockClear()
    fireEvent.wheel(chartFrame as Element, { deltaY: -100 })
    expect(onBandCommit).not.toHaveBeenCalled()
  })

  it('changes high Q more than low Q with one wheel step', () => {
    const lowBand: EqBand = {
      id: 'band-low',
      type: 'peaking',
      frequencyHz: 1000,
      isBypassed: false,
      gainDb: 3,
      q: 1,
      slopeDbPerOct: 12,
    }
    const highBand: EqBand = {
      ...lowBand,
      id: 'band-high',
      q: 10,
    }

    const lowCommit = vi.fn()
    const lowRender = renderChart({
      bands: [lowBand],
      selectedBandId: lowBand.id,
      onBandCommit: lowCommit,
    })

    const lowNode = within(lowRender.container).getByLabelText('Bell band')
    const lowFrame = lowRender.container.querySelector('.chart-frame')
    expect(lowFrame).toBeTruthy()

    fireEvent.pointerDown(lowNode, {
      pointerId: 1,
      clientX: 600,
      clientY: 350,
    })
    lowCommit.mockClear()
    fireEvent.wheel(lowFrame as Element, { deltaY: -100 })
    const lowNextQ = lowCommit.mock.calls[0]?.[0]?.q as number
    fireEvent.pointerUp(lowNode, { pointerId: 1 })

    cleanup()

    const highCommit = vi.fn()
    const highRender = renderChart({
      bands: [highBand],
      selectedBandId: highBand.id,
      onBandCommit: highCommit,
    })

    const highNode = within(highRender.container).getByLabelText('Bell band')
    const highFrame = highRender.container.querySelector('.chart-frame')
    expect(highFrame).toBeTruthy()

    fireEvent.pointerDown(highNode, {
      pointerId: 1,
      clientX: 600,
      clientY: 350,
    })
    highCommit.mockClear()
    fireEvent.wheel(highFrame as Element, { deltaY: -100 })
    const highNextQ = highCommit.mock.calls[0]?.[0]?.q as number

    expect(highNextQ - highBand.q).toBeGreaterThan(lowNextQ - lowBand.q)
  })

  it('keeps Q within min and max bounds when using wheel', () => {
    const onBandCommit = vi.fn()
    const maxBand: EqBand = {
      id: 'band-max',
      type: 'peaking',
      frequencyHz: 1000,
      isBypassed: false,
      gainDb: 3,
      q: 12,
      slopeDbPerOct: 12,
    }

    const maxRender = renderChart({
      bands: [maxBand],
      selectedBandId: maxBand.id,
      onBandCommit,
    })

    const maxNode = within(maxRender.container).getByLabelText('Bell band')
    const maxFrame = maxRender.container.querySelector('.chart-frame')
    expect(maxFrame).toBeTruthy()

    fireEvent.pointerDown(maxNode, {
      pointerId: 1,
      clientX: 600,
      clientY: 350,
    })
    onBandCommit.mockClear()
    fireEvent.wheel(maxFrame as Element, { deltaY: -100 })
    expect(onBandCommit).toHaveBeenCalledWith({
      ...maxBand,
      q: 12,
    }, 'immediate')

    cleanup()

    const minBand: EqBand = {
      ...maxBand,
      id: 'band-min',
      q: 0.1,
    }
    const minCommit = vi.fn()
    const minRender = renderChart({
      bands: [minBand],
      selectedBandId: minBand.id,
      onBandCommit: minCommit,
    })

    const minNode = within(minRender.container).getByLabelText('Bell band')
    const minFrame = minRender.container.querySelector('.chart-frame')
    expect(minFrame).toBeTruthy()

    fireEvent.pointerDown(minNode, {
      pointerId: 1,
      clientX: 600,
      clientY: 350,
    })
    minCommit.mockClear()
    fireEvent.wheel(minFrame as Element, { deltaY: 100 })
    expect(minCommit).toHaveBeenCalledWith({
      ...minBand,
      q: 0.1,
    }, 'immediate')
  })

  it('approximately returns to original Q after one up and one down wheel step', () => {
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

    const { container, rerender } = renderChart({
      bands: [band],
      selectedBandId: band.id,
      onBandCommit,
    })

    const node = within(container).getByLabelText('Bell band')
    const chartFrame = container.querySelector('.chart-frame')
    expect(chartFrame).toBeTruthy()

    fireEvent.pointerDown(node, {
      pointerId: 1,
      clientX: 600,
      clientY: 350,
    })
    onBandCommit.mockClear()
    fireEvent.wheel(chartFrame as Element, { deltaY: -100 })
    const qAfterUp = onBandCommit.mock.calls[0]?.[0]?.q as number

    rerender(
      <EqChart
        baselineCurve={baselineCurve}
        bandCurve={createFlatCurve([20, 1000, 20000])}
        outputCurve={baselineCurve}
        bands={[{ ...band, q: qAfterUp }]}
        selectedBandId={band.id}
        visualGainDb={30}
        viewMinDb={-15}
        viewMaxDb={15}
        onBandCommit={onBandCommit}
        onBandCreate={vi.fn()}
        onBandDelete={vi.fn()}
        onBandToggleBypass={vi.fn()}
        onBandSelect={vi.fn()}
        onIncreaseViewMax={vi.fn()}
        onDecreaseViewMax={vi.fn()}
        onIncreaseViewMin={vi.fn()}
        onDecreaseViewMin={vi.fn()}
      />,
    )

    onBandCommit.mockClear()
    fireEvent.wheel(chartFrame as Element, { deltaY: 100 })
    const qAfterDown = onBandCommit.mock.calls[0]?.[0]?.q as number
    expect(qAfterDown).toBeCloseTo(band.q, 2)
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

    expect(onBandCommit).toHaveBeenCalled()
    expect(onBandCommit.mock.calls[0][1]).toBe('smooth')

    onBandCommit.mockClear()
    fireEvent.pointerUp(node, { pointerId: 1 })
    expect(onBandCommit).toHaveBeenCalled()
    expect(onBandCommit.mock.calls.at(-1)?.[1]).toBe('smooth')
  })

  it('uses a dynamic viewBox without stretch-only preserveAspectRatio overrides', () => {
    renderChart()

    const chartSurface = screen.getByLabelText('EQ editing surface')
    expect(chartSurface.getAttribute('preserveAspectRatio')).toBeNull()
    expect(chartSurface.getAttribute('viewBox')).toBe('0 0 1200 700')
  })

  it('keeps smooth drag commits in a non-standard aspect ratio', () => {
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

    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 1600,
      height: 500,
      top: 0,
      left: 0,
      right: 1600,
      bottom: 500,
      toJSON: () => ({}),
    })

    renderChart({
      bands: [band],
      selectedBandId: band.id,
      onBandCommit,
    })

    const node = screen.getByLabelText('Bell band')
    fireEvent.pointerDown(node, {
      pointerId: 1,
      clientX: 800,
      clientY: 250,
    })
    onBandCommit.mockClear()

    fireEvent.pointerMove(node, {
      pointerId: 1,
      clientX: 920,
      clientY: 240,
    })
    expect(onBandCommit).toHaveBeenCalledTimes(1)
    expect(onBandCommit.mock.calls[0][1]).toBe('smooth')
    const firstCommittedFrequency = onBandCommit.mock.calls[0][0].frequencyHz

    fireEvent.pointerUp(node, { pointerId: 1 })
    onBandCommit.mockClear()

    const updatedNode = screen.getByLabelText('Bell band')
    fireEvent.pointerDown(updatedNode, {
      pointerId: 1,
      clientX: 1080,
      clientY: 220,
    })
    fireEvent.pointerMove(updatedNode, {
      pointerId: 1,
      clientX: 1240,
      clientY: 200,
    })

    expect(onBandCommit).toHaveBeenCalledTimes(1)
    expect(onBandCommit.mock.calls[0][1]).toBe('smooth')
    const secondCommittedFrequency = onBandCommit.mock.calls[0][0].frequencyHz
    expect(secondCommittedFrequency).toBeGreaterThan(firstCommittedFrequency)
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
      onBandToggleBypass,
    })

    await user.click(screen.getByLabelText('Bell band'))
    await user.click(screen.getByRole('button', { name: 'Bypassed' }))
    expect(onBandToggleBypass).toHaveBeenCalledWith('band-1')
  })

  it('renders the band popover through a body portal', async () => {
    const user = userEvent.setup()
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
    })

    await user.click(screen.getByLabelText('Bell band'))

    const popoverTitle = screen.getByText('Selected node')
    const popover = popoverTitle.closest('.band-popover')
    const chartFrame = container.querySelector('.chart-frame')
    expect(popover).toBeTruthy()
    expect(popover?.parentElement).toBe(document.body)
    expect(chartFrame?.contains(popover as Node)).toBe(false)
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

  it('renders FFT canvas when a store is provided', () => {
    renderChart({
      fftStore: createFftStore(),
      hasFftFrame: true,
    })

    expect(screen.getByTestId('fft-canvas')).toBeTruthy()
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

  it('keeps FFT canvas mounted when frame availability toggles', () => {
    const { rerender } = renderChart({
      fftStore: createFftStore(),
      hasFftFrame: false,
    })

    rerender(
      <EqChart
        baselineCurve={baselineCurve}
        bandCurve={createFlatCurve([20, 1000, 20000])}
        outputCurve={baselineCurve}
        bands={[]}
        visualGainDb={30}
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
        fftStore={createFftStore()}
        hasFftFrame={true}
      />,
    )

    expect(screen.getByTestId('fft-canvas')).toBeTruthy()
  })
})


