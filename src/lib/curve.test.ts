import { describe, expect, it } from 'vitest'
import { createFlatCurve, createLogFrequencyGrid, sumCurves } from './curve'

describe('curve helpers', () => {
  it('creates a fixed 512-point logarithmic grid by default', () => {
    const grid = createLogFrequencyGrid()
    expect(grid).toHaveLength(512)
    expect(grid[0]).toBeCloseTo(20, 6)
    expect(grid.at(-1)).toBeCloseTo(20000, 6)
  })

  it('creates a flat curve and sums curves pointwise', () => {
    const baseline = createFlatCurve([20, 1000, 20000])
    const output = sumCurves(baseline, [
      { frequencyHz: 20, gainDb: -1 },
      { frequencyHz: 1000, gainDb: 2 },
      { frequencyHz: 20000, gainDb: 0.5 },
    ])

    expect(output).toEqual([
      { frequencyHz: 20, gainDb: -1 },
      { frequencyHz: 1000, gainDb: 2 },
      { frequencyHz: 20000, gainDb: 0.5 },
    ])
  })
})
