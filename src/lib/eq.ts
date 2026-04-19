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
  sampleRateHz: number,
): CurvePoint[] {
  const sections = designBandSections(band, sampleRateHz)
  const magnitudes = frequencies.map((frequencyHz) =>
    getCascadeMagnitudeResponse(sections, frequencyHz, sampleRateHz),
  )
  return magnitudesToDbResponse(frequencies, magnitudes)
}

function computeBandResponse(
  band: EqBand,
  frequencies: number[],
  sampleRateHz: number,
) {
  return computeStageResponse(band, frequencies, sampleRateHz)
}

export function computeEqCurve(
  bands: EqBand[],
  frequencies: number[],
  sampleRateHz = DEFAULT_RESPONSE_SAMPLE_RATE,
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
    const bandCurve = computeBandResponse(band, frequencies, sampleRateHz)
    return sumCurve.map((point, index) => ({
      frequencyHz: point.frequencyHz,
      gainDb: point.gainDb + bandCurve[index].gainDb,
    }))
  }, frequencies.map((frequencyHz) => ({ frequencyHz, gainDb: 0 })))
}

export function sumCurveWithEq(baseCurve: CurvePoint[], eqCurve: CurvePoint[]) {
  return sumCurves(baseCurve, eqCurve)
}
