import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EqChart } from './EqChart'
import { createFlatCurve } from '../lib/curve'
import type { EqBand } from '../types'

const baselineCurve = createFlatCurve([20, 1000, 20000])

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
    vi.restoreAllMocks()
  })

  it('creates a peaking band when the chart is double-clicked', async () => {
    const user = userEvent.setup()
    const onBandCreate = vi.fn()

    render(
      <EqChart
        baselineCurve={baselineCurve}
        bandCurve={createFlatCurve([20, 1000, 20000])}
        outputCurve={baselineCurve}
        bands={[]}
        showFlatHint
        onBandCommit={vi.fn()}
        onBandCreate={onBandCreate}
        onBandDelete={vi.fn()}
        onBandSelect={vi.fn()}
      />,
    )

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
      gainDb: 3,
      q: 1.1,
    }

    render(
      <EqChart
        baselineCurve={baselineCurve}
        bandCurve={createFlatCurve([20, 1000, 20000])}
        outputCurve={baselineCurve}
        bands={[band]}
        selectedBandId={band.id}
        showFlatHint={false}
        onBandCommit={vi.fn()}
        onBandCreate={vi.fn()}
        onBandDelete={onBandDelete}
        onBandSelect={vi.fn()}
      />,
    )

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
      gainDb: 3,
      q: 1.1,
    }

    const { container } = render(
      <EqChart
        baselineCurve={baselineCurve}
        bandCurve={createFlatCurve([20, 1000, 20000])}
        outputCurve={baselineCurve}
        bands={[band]}
        selectedBandId={band.id}
        showFlatHint={false}
        onBandCommit={onBandCommit}
        onBandCreate={vi.fn()}
        onBandDelete={vi.fn()}
        onBandSelect={vi.fn()}
      />,
    )

    const chart = within(container)
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
      gainDb: 3,
      q: 1.1,
    }

    const { container } = render(
      <EqChart
        baselineCurve={baselineCurve}
        bandCurve={createFlatCurve([20, 1000, 20000])}
        outputCurve={baselineCurve}
        bands={[band]}
        selectedBandId={band.id}
        showFlatHint={false}
        onBandCommit={onBandCommit}
        onBandCreate={vi.fn()}
        onBandDelete={vi.fn()}
        onBandSelect={vi.fn()}
      />,
    )

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
})
