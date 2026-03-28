import { describe, expect, it } from 'vitest'
import { computeAutoPreGainDb } from './pre-gain'

describe('computeAutoPreGainDb', () => {
  it('keeps the reserved -8 dB headroom below the threshold', () => {
    expect(computeAutoPreGainDb(0)).toBe(-8)
    expect(computeAutoPreGainDb(4)).toBe(-8)
    expect(computeAutoPreGainDb(8)).toBe(-8)
  })

  it('adds more attenuation only after the raw peak exceeds +8 dB', () => {
    expect(computeAutoPreGainDb(10)).toBe(-10)
    expect(computeAutoPreGainDb(14.5)).toBe(-14.5)
  })
})
