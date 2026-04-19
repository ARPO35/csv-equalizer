import { describe, expect, it } from 'vitest'
import { computeEqCurve } from './eq'
import type { EqBand } from '../types'

describe('computeEqCurve', () => {
  it('returns a flat zero curve when no bands exist', () => {
    const curve = computeEqCurve([], [20, 1000, 20000])
    expect(curve).toEqual([
      { frequencyHz: 20, gainDb: 0 },
      { frequencyHz: 1000, gainDb: 0 },
      { frequencyHz: 20000, gainDb: 0 },
    ])
  })

  it('creates a peaking boost near the center frequency', () => {
    const bands: EqBand[] = [
      {
        id: 'band-1',
        type: 'peaking',
        frequencyHz: 1000,
        isBypassed: false,
        gainDb: 6,
        q: 1,
        slopeDbPerOct: 12,
      },
    ]

    const curve = computeEqCurve(bands, [100, 1000, 10000])
    expect(curve[1].gainDb).toBeGreaterThan(curve[0].gainDb)
    expect(curve[1].gainDb).toBeGreaterThan(curve[2].gainDb)
  })

  it('makes steeper peaking slopes narrower at the same Q and gain', () => {
    const gentle: EqBand[] = [
      {
        id: 'peak-12',
        type: 'peaking',
        frequencyHz: 1000,
        isBypassed: false,
        gainDb: 6,
        q: 1,
        slopeDbPerOct: 12,
      },
    ]
    const steep: EqBand[] = [
      {
        id: 'peak-48',
        type: 'peaking',
        frequencyHz: 1000,
        isBypassed: false,
        gainDb: 6,
        q: 1,
        slopeDbPerOct: 48,
      },
    ]

    const sampleFrequencies = [500, 1000, 2000]
    const gentleCurve = computeEqCurve(gentle, sampleFrequencies)
    const steepCurve = computeEqCurve(steep, sampleFrequencies)

    expect(steepCurve[1].gainDb).toBeCloseTo(gentleCurve[1].gainDb, 4)
    expect(steepCurve[0].gainDb).toBeLessThan(gentleCurve[0].gainDb)
    expect(steepCurve[2].gainDb).toBeLessThan(gentleCurve[2].gainDb)
  })

  it('keeps peaking Q as the primary bandwidth control', () => {
    const narrow: EqBand[] = [
      {
        id: 'peak-q-high',
        type: 'peaking',
        frequencyHz: 1000,
        isBypassed: false,
        gainDb: 6,
        q: 4,
        slopeDbPerOct: 12,
      },
    ]
    const wide: EqBand[] = [
      {
        id: 'peak-q-low',
        type: 'peaking',
        frequencyHz: 1000,
        isBypassed: false,
        gainDb: 6,
        q: 0.5,
        slopeDbPerOct: 12,
      },
    ]

    const sampleFrequencies = [500, 1000, 2000]
    const narrowCurve = computeEqCurve(narrow, sampleFrequencies)
    const wideCurve = computeEqCurve(wide, sampleFrequencies)

    expect(narrowCurve[1].gainDb).toBeCloseTo(wideCurve[1].gainDb, 4)
    expect(narrowCurve[0].gainDb).toBeLessThan(wideCurve[0].gainDb)
    expect(narrowCurve[2].gainDb).toBeLessThan(wideCurve[2].gainDb)
  })

  it('makes steeper shelf slopes transition more sharply', () => {
    const gentle: EqBand[] = [
      {
        id: 'shelf-12',
        type: 'lowShelf',
        frequencyHz: 1000,
        isBypassed: false,
        gainDb: 6,
        q: Math.SQRT1_2,
        slopeDbPerOct: 12,
      },
    ]
    const steep: EqBand[] = [
      {
        id: 'shelf-48',
        type: 'lowShelf',
        frequencyHz: 1000,
        isBypassed: false,
        gainDb: 6,
        q: Math.SQRT1_2,
        slopeDbPerOct: 48,
      },
    ]

    const sampleFrequencies = [100, 1000, 2000]
    const gentleCurve = computeEqCurve(gentle, sampleFrequencies)
    const steepCurve = computeEqCurve(steep, sampleFrequencies)

    expect(steepCurve[0].gainDb).toBeCloseTo(gentleCurve[0].gainDb, 4)
    expect(steepCurve[1].gainDb).toBeLessThan(gentleCurve[1].gainDb)
    expect(steepCurve[2].gainDb).toBeLessThan(gentleCurve[2].gainDb)
  })

  it('makes steeper cut slopes more attenuated', () => {
    const gentle: EqBand[] = [
      {
        id: 'cut-12',
        type: 'lowCut',
        frequencyHz: 200,
        isBypassed: false,
        slopeDbPerOct: 12,
      },
    ]
    const steep: EqBand[] = [
      {
        id: 'cut-48',
        type: 'lowCut',
        frequencyHz: 200,
        isBypassed: false,
        slopeDbPerOct: 48,
      },
    ]

    const gentleCurve = computeEqCurve(gentle, [20, 200, 1000])
    const steepCurve = computeEqCurve(steep, [20, 200, 1000])

    expect(steepCurve[0].gainDb).toBeLessThan(gentleCurve[0].gainDb)
    expect(steepCurve).toHaveLength(gentleCurve.length)
  })
})
