import { sumCurves } from './curve'
import type { CurvePoint, EqBand } from '../types'

const MAGNITUDE_FLOOR = 1e-8
const CUT_Q = Math.SQRT1_2

let cachedAudioContext: AudioContext | null = null

function getAudioContext() {
  if (cachedAudioContext) {
    return cachedAudioContext
  }

  const ContextConstructor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext

  if (!ContextConstructor) {
    throw new Error('This browser does not support Web Audio filter analysis.')
  }

  cachedAudioContext = new ContextConstructor()
  return cachedAudioContext
}

function magnitudesToDbResponse(
  frequencies: number[],
  magnitudes: Float32Array<ArrayBufferLike>,
): CurvePoint[] {
  return frequencies.map((frequencyHz, index) => ({
    frequencyHz,
    gainDb: 20 * Math.log10(Math.max(magnitudes[index], MAGNITUDE_FLOOR)),
  }))
}

function createSingleFilterResponse(
  band: EqBand,
  frequencyArray: Float32Array,
  gainDbOverride?: number,
): Float32Array {
  const context = getAudioContext()
  const filter = context.createBiquadFilter()
  filter.frequency.value = band.frequencyHz

  if (band.type === 'peaking') {
    filter.type = 'peaking'
    filter.gain.value = gainDbOverride ?? band.gainDb
    filter.Q.value = band.q
  } else if (band.type === 'lowShelf' || band.type === 'highShelf') {
    filter.type = band.type === 'lowShelf' ? 'lowshelf' : 'highshelf'
    filter.gain.value = gainDbOverride ?? band.gainDb
  } else {
    filter.type = band.type === 'lowCut' ? 'highpass' : 'lowpass'
    filter.Q.value = CUT_Q
  }

  const magnitudes = new Float32Array(frequencyArray.length)
  const phases = new Float32Array(frequencyArray.length)
  filter.getFrequencyResponse(
    frequencyArray as Float32Array<ArrayBuffer>,
    magnitudes,
    phases,
  )

  return magnitudes
}

function getStageCount(band: EqBand) {
  if (band.type === 'lowCut' || band.type === 'highCut') {
    return band.slopeDbPerOct / 12
  }
  return band.slopeDbPerOct / 6
}

function computeStageResponse(
  band: EqBand,
  frequencyArray: Float32Array,
): Float32Array {
  const stageCount = getStageCount(band)
  const stageGainDb = 'gainDb' in band ? band.gainDb / stageCount : undefined
  const accumulatedMagnitudes = new Float32Array(frequencyArray.length)
  accumulatedMagnitudes.fill(1)

  for (let index = 0; index < stageCount; index += 1) {
    const stageMagnitudes = createSingleFilterResponse(
      band,
      frequencyArray,
      stageGainDb,
    )

    for (let magnitudeIndex = 0; magnitudeIndex < stageMagnitudes.length; magnitudeIndex += 1) {
      accumulatedMagnitudes[magnitudeIndex] *= stageMagnitudes[magnitudeIndex]
    }
  }

  return accumulatedMagnitudes
}

function computeBandResponse(band: EqBand, frequencyArray: Float32Array) {
  return computeStageResponse(band, frequencyArray)
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

  const frequencyArray = Float32Array.from(frequencies)
  const combinedMagnitudes = new Float32Array(frequencyArray.length)
  combinedMagnitudes.fill(1)

  bands.forEach((band) => {
    const bandMagnitudes = computeBandResponse(band, frequencyArray)
    for (let index = 0; index < bandMagnitudes.length; index += 1) {
      combinedMagnitudes[index] *= bandMagnitudes[index]
    }
  })

  return magnitudesToDbResponse(frequencies, combinedMagnitudes)
}

export function sumCurveWithEq(baseCurve: CurvePoint[], eqCurve: CurvePoint[]) {
  return sumCurves(baseCurve, eqCurve)
}
