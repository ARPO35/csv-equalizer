import { describe, expect, it } from 'vitest'
import { convertBandType, createDefaultBand } from './bands'

describe('band helpers', () => {
  it('creates new bands as active by default', () => {
    expect(createDefaultBand('peaking')).toMatchObject({
      type: 'peaking',
      isBypassed: false,
    })
  })

  it('preserves bypass state when converting band types', () => {
    const band = createDefaultBand('peaking', {
      id: 'band-1',
      frequencyHz: 1000,
      gainDb: 3,
      q: 1.2,
      isBypassed: true,
    })

    expect(convertBandType(band, 'highShelf')).toMatchObject({
      id: 'band-1',
      type: 'highShelf',
      frequencyHz: 1000,
      isBypassed: true,
      gainDb: 3,
    })
  })
})
