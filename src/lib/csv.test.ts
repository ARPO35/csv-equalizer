import { describe, expect, it } from 'vitest'
import { parseCurveCsv } from './csv'

describe('parseCurveCsv', () => {
  it('parses a valid frequency/gain csv', () => {
    const curve = parseCurveCsv('frequency,gain\n20,-3\n1000,0\n20000,2.5')
    expect(curve).toEqual([
      { frequencyHz: 20, gainDb: -3 },
      { frequencyHz: 1000, gainDb: 0 },
      { frequencyHz: 20000, gainDb: 2.5 },
    ])
  })

  it('rejects invalid headers', () => {
    expect(() => parseCurveCsv('freq,gain\n20,-3')).toThrow(
      'CSV header must be exactly: frequency,gain',
    )
  })

  it('rejects non-increasing frequency values', () => {
    expect(() => parseCurveCsv('frequency,gain\n20,0\n20,1')).toThrow(
      'Frequency values must be strictly increasing.',
    )
  })
})
