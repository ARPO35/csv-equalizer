import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EqChart } from './EqChart'
import { createFlatCurve } from '../lib/curve'
import type { EqBand } from '../types'

const baselineCurve = createFlatCurve([20, 1000, 20000])

function renderChart(
  overrides: Partial<React.ComponentProps<typeof EqChart>> = {},
) {
  return render(
    <EqChart
      baselineCurve={baselineCurve}
      bandCurve={createFlatCurve([20, 1000, 20000])}
      outputCurve={baselineCurve}
      bands={[]}
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
    })
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
    })

    fireEvent.pointerUp(node, { pointerId: 1 })
    onBandCommit.mockClear()
    fireEvent.wheel(chartFrame as Element, { deltaY: -100 })
    expect(onBandCommit).not.toHaveBeenCalled()
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
    })
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
    })
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
})


