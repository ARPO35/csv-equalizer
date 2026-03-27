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
  magnitudes: Float32Array,
): CurvePoint[] {
  return frequencies.map((frequencyHz, index) => ({
    frequencyHz,
    gainDb: 20 * Math.log10(Math.max(magnitudes[index], MAGNITUDE_FLOOR)),
  }))
}

function createSingleFilterResponse(
  band: EqBand,
  frequencies: number[],
): CurvePoint[] {
  const context = getAudioContext()
  const filter = context.createBiquadFilter()
  filter.frequency.value = band.frequencyHz

  if (band.type === 'peaking') {
    filter.type = 'peaking'
    filter.gain.value = band.gainDb
    filter.Q.value = band.q
  } else if (band.type === 'lowShelf' || band.type === 'highShelf') {
    filter.type = band.type === 'lowShelf' ? 'lowshelf' : 'highshelf'
    filter.gain.value = band.gainDb
  } else {
    filter.type = band.type === 'lowCut' ? 'highpass' : 'lowpass'
    filter.Q.value = CUT_Q
  }

  const frequencyArray = Float32Array.from(frequencies)
  const magnitudes = new Float32Array(frequencies.length)
  const phases = new Float32Array(frequencies.length)
  filter.getFrequencyResponse(frequencyArray, magnitudes, phases)

  return magnitudesToDbResponse(frequencies, magnitudes)
}

function computeCutResponse(
  band: Extract<EqBand, { type: 'lowCut' | 'highCut' }>,
  frequencies: number[],
): CurvePoint[] {
  const stageCount = band.slopeDbPerOct / 12
  return Array.from({ length: stageCount }).reduce<CurvePoint[] | null>(
    (sumCurve) => {
      const stageCurve = createSingleFilterResponse(band, frequencies)
      if (!sumCurve) {
        return stageCurve
      }

      return sumCurve.map((point, index) => ({
        frequencyHz: point.frequencyHz,
        gainDb: point.gainDb + stageCurve[index].gainDb,
      }))
    },
    null,
  ) ?? []
}

function computeBandResponse(band: EqBand, frequencies: number[]) {
  if (band.type === 'lowCut' || band.type === 'highCut') {
    return computeCutResponse(band, frequencies)
  }
  return createSingleFilterResponse(band, frequencies)
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

export function sumCurveWithEq(
  sourceCurve: CurvePoint[],
  eqCurve: CurvePoint[],
): CurvePoint[] {
  return sourceCurve.map((point, index) => ({
    frequencyHz: point.frequencyHz,
    gainDb: point.gainDb + (eqCurve[index]?.gainDb ?? 0),
  }))
}
