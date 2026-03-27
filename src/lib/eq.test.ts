import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computeEqCurve } from './eq'
import type { EqBand } from '../types'

class FakeBiquadFilter {
  type: BiquadFilterType = 'peaking'
  frequency = { value: 1000 }
  gain = { value: 0 }
  Q = { value: 1 }

  getFrequencyResponse(
    frequencies: Float32Array,
    magnitudes: Float32Array,
    phases: Float32Array,
  ) {
    frequencies.forEach((frequency, index) => {
      const ratio = Math.log2(Math.max(frequency, 1) / this.frequency.value)
      const gaussian = Math.exp(-(ratio ** 2) / Math.max(this.Q.value, 0.1))
      let linearGain = 1

      switch (this.type) {
        case 'peaking':
          linearGain = 10 ** ((this.gain.value * gaussian) / 20)
          break
        case 'lowshelf':
          linearGain = frequency <= this.frequency.value ? 10 ** (this.gain.value / 20) : 1
          break
        case 'highshelf':
          linearGain = frequency >= this.frequency.value ? 10 ** (this.gain.value / 20) : 1
          break
        case 'highpass':
          linearGain = Math.min(1, frequency / this.frequency.value)
          break
        case 'lowpass':
          linearGain = Math.min(1, this.frequency.value / Math.max(frequency, 1))
          break
        default:
          linearGain = 1
      }

      magnitudes[index] = linearGain
      phases[index] = 0
    })
  }
}

class FakeAudioContext {
  createBiquadFilter() {
    return new FakeBiquadFilter()
  }
}

describe('computeEqCurve', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      writable: true,
      value: FakeAudioContext,
    })
  })

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
      },
    ]

    const curve = computeEqCurve(bands, [100, 1000, 10000])
    expect(curve[1].gainDb).toBeGreaterThan(curve[0].gainDb)
    expect(curve[1].gainDb).toBeGreaterThan(curve[2].gainDb)
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
