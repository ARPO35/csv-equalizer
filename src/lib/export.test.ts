import { describe, expect, it } from 'vitest'
import {
  getExportFormats,
  getExportFrequencies,
  prepareExportCurve,
  serializeExportCurve,
  type ExportFormatConfig,
} from './export'

const sourceCurve = [
  { frequencyHz: 20, gainDb: -2 },
  { frequencyHz: 1000, gainDb: 4 },
  { frequencyHz: 20000, gainDb: 1 },
]

const csvFormat: ExportFormatConfig = {
  id: 'csv',
  label: 'CSV',
  description: 'CSV',
  extension: '.csv',
  mimeType: 'text/csv',
  serializer: 'csv',
  frequencyMode: 'custom-log',
  gainDecimals: 2,
  frequencyDecimals: 0,
}

const graphicFormat: ExportFormatConfig = {
  id: 'graphic',
  label: 'GraphicEQ',
  description: 'GraphicEQ',
  extension: '.txt',
  mimeType: 'text/plain',
  serializer: 'graphic-eq',
  frequencyMode: 'custom-log',
  gainDecimals: 1,
  frequencyDecimals: 0,
}

const spotifyFormat: ExportFormatConfig = {
  id: 'spotify',
  label: 'Spotify',
  description: 'Spotify',
  extension: '.txt',
  mimeType: 'text/plain',
  serializer: 'fixed-band-text',
  frequencyMode: 'fixed',
  fixedFrequencies: [60, 1000],
  fixedLabels: ['60 Hz', '1 kHz'],
  gainDecimals: 1,
  frequencyDecimals: 0,
}

describe('export formats', () => {
  it('loads built-in format configs from json files', () => {
    const formats = getExportFormats()
    expect(formats.map((format) => format.id)).toEqual([
      'csv',
      'equalizer-apo-graphic',
      'spotify-built-in-eq',
      'wavelet',
    ])
  })

  it('uses custom log precision or fixed frequencies from config', () => {
    expect(getExportFrequencies(csvFormat, 4)).toHaveLength(4)
    expect(getExportFrequencies(spotifyFormat, 128)).toEqual([60, 1000])
  })

  it('applies pre-gain, inversion, then alignment', () => {
    const curve = prepareExportCurve({
      sourceCurve,
      frequencies: [20, 1000, 20000],
      preGainDb: -1,
      invert: true,
      alignment: 'max-to-zero',
    })

    expect(curve.map((point) => point.gainDb)).toEqual([0, -6, -3])
  })

  it('serializes csv and GraphicEQ output', () => {
    const curve = [
      { frequencyHz: 20, gainDb: -1.234 },
      { frequencyHz: 1000, gainDb: 2 },
    ]

    expect(serializeExportCurve(csvFormat, curve)).toBe(
      'frequency,gain\n20,-1.23\n1000,2',
    )
    expect(serializeExportCurve(graphicFormat, curve)).toBe(
      'GraphicEQ: 20 -1.2; 1000 2',
    )
  })

  it('serializes fixed-band text output for manual EQs', () => {
    expect(
      serializeExportCurve(spotifyFormat, [
        { frequencyHz: 60, gainDb: -2 },
        { frequencyHz: 1000, gainDb: 1.25 },
      ]),
    ).toBe('60 Hz: -2 dB\n1 kHz: 1.3 dB')
  })
})
