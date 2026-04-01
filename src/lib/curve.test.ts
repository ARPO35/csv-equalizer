import { describe, expect, it } from 'vitest'
import {
  createFlatCurve,
  createLogFrequencyGrid,
  resampleCurve,
  sumCurves,
} from './curve'

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

  it('resamples a curve onto a target logarithmic grid', () => {
    const resampled = resampleCurve(
      [
        { frequencyHz: 20, gainDb: -3 },
        { frequencyHz: 1000, gainDb: 3 },
        { frequencyHz: 20000, gainDb: 0 },
      ],
      [20, 200, 1000, 20000],
    )

    expect(resampled[0]).toEqual({ frequencyHz: 20, gainDb: -3 })
    expect(resampled[1].frequencyHz).toBe(200)
    expect(resampled[1].gainDb).toBeCloseTo(0.531551, 6)
    expect(resampled[2]).toEqual({ frequencyHz: 1000, gainDb: 3 })
    expect(resampled[3]).toEqual({ frequencyHz: 20000, gainDb: 0 })
  })
})
