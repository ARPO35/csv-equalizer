import {
  DEFAULT_RESPONSE_SAMPLE_RATE,
  designBandSections,
  getCascadeMagnitudeResponse,
} from './filter-coefficients'
import { sumCurves } from './curve'
import type { CurvePoint, EqBand } from '../types'

const MAGNITUDE_FLOOR = 1e-8

function magnitudesToDbResponse(
  frequencies: number[],
  magnitudes: number[],
): CurvePoint[] {
  return frequencies.map((frequencyHz, index) => ({
    frequencyHz,
    gainDb: 20 * Math.log10(Math.max(magnitudes[index], MAGNITUDE_FLOOR)),
  }))
}

function computeStageResponse(
  band: EqBand,
  frequencies: number[],
): CurvePoint[] {
  const sections = designBandSections(band, DEFAULT_RESPONSE_SAMPLE_RATE)
  const magnitudes = frequencies.map((frequencyHz) =>
    getCascadeMagnitudeResponse(
      sections,
      frequencyHz,
      DEFAULT_RESPONSE_SAMPLE_RATE,
    ),
  )
  return magnitudesToDbResponse(frequencies, magnitudes)
}

function computeBandResponse(band: EqBand, frequencies: number[]) {
  return computeStageResponse(band, frequencies)
}

export function computeEqCurve(
  bands: EqBand[],
  frequencies: number[],
): CurvePoint[] {
  if (frequencies.length === 0) {
    return []
  }

  if (bands.length === 0) {
    return frequencies.map((frequencyHz) => ({
      frequencyHz,
      gainDb: 0,
    }))
  }

  return bands.reduce<CurvePoint[]>((sumCurve, band) => {
    const bandCurve = computeBandResponse(band, frequencies)
    return sumCurve.map((point, index) => ({
      frequencyHz: point.frequencyHz,
      gainDb: point.gainDb + bandCurve[index].gainDb,
    }))
  }, frequencies.map((frequencyHz) => ({ frequencyHz, gainDb: 0 })))
}

export function sumCurveWithEq(baseCurve: CurvePoint[], eqCurve: CurvePoint[]) {
  return sumCurves(baseCurve, eqCurve)
}
