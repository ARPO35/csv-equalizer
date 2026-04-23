import { sumCurves } from './curve'
import type { CurvePoint, EqBand } from '../types'

const MAGNITUDE_FLOOR = 1e-8
const CUT_Q = Math.SQRT1_2
const MAX_BAND_CACHE_SIZE = 256

let cachedAudioContext: AudioContext | null = null
const frequencyArrayCache = new WeakMap<number[], Float32Array>()
const bandResponseCache = new WeakMap<number[], Map<string, Float32Array>>()

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

function getFrequencyArray(frequencies: number[]) {
  const cached = frequencyArrayCache.get(frequencies)
  if (cached) {
    return cached
  }

  const frequencyArray = Float32Array.from(frequencies)
  frequencyArrayCache.set(frequencies, frequencyArray)
  return frequencyArray
}

function getBandCache(frequencies: number[]) {
  const cached = bandResponseCache.get(frequencies)
  if (cached) {
    return cached
  }

  const cache = new Map<string, Float32Array>()
  bandResponseCache.set(frequencies, cache)
  return cache
}

function getBandSignature(band: EqBand) {
  const base = [
    band.id,
    band.type,
    band.frequencyHz,
    band.slopeDbPerOct,
    band.isBypassed ? 1 : 0,
  ]
  if ('gainDb' in band) {
    base.push(band.gainDb)
  }
  if ('q' in band) {
    base.push(band.q)
  }
  return base.join('|')
}

function createSingleFilterResponse(
  band: EqBand,
  frequencies: number[],
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

  const frequencyArray = getFrequencyArray(frequencies)
  const magnitudes = new Float32Array(frequencies.length)
  const phases = new Float32Array(frequencies.length)
  filter.getFrequencyResponse(
    frequencyArray as Float32Array<ArrayBuffer>,
    magnitudes as Float32Array<ArrayBuffer>,
    phases as Float32Array<ArrayBuffer>,
  )

  const response = new Float32Array(frequencies.length)
  for (let index = 0; index < magnitudes.length; index += 1) {
    response[index] = 20 * Math.log10(Math.max(magnitudes[index], MAGNITUDE_FLOOR))
  }
  return response
}

function getStageCount(band: EqBand) {
  if (band.type === 'lowCut' || band.type === 'highCut') {
    return band.slopeDbPerOct / 12
  }
  return band.slopeDbPerOct / 6
}

function computeStageResponse(
  band: EqBand,
  frequencies: number[],
): Float32Array {
  const stageCount = getStageCount(band)
  const stageGainDb = 'gainDb' in band ? band.gainDb / stageCount : undefined
  const response = new Float32Array(frequencies.length)

  for (let stageIndex = 0; stageIndex < stageCount; stageIndex += 1) {
    const stageResponse = createSingleFilterResponse(band, frequencies, stageGainDb)
    for (let index = 0; index < response.length; index += 1) {
      response[index] += stageResponse[index]
    }
  }

  return response
}

function computeBandResponse(band: EqBand, frequencies: number[]) {
  const cache = getBandCache(frequencies)
  const signature = getBandSignature(band)
  const cached = cache.get(signature)
  if (cached) {
    return cached
  }

  const response = computeStageResponse(band, frequencies)
  if (cache.size >= MAX_BAND_CACHE_SIZE) {
    cache.clear()
  }
  cache.set(signature, response)
  return response
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

  const gainDbBuffer = new Float32Array(frequencies.length)
  bands.forEach((band) => {
    const bandCurve = computeBandResponse(band, frequencies)
    for (let index = 0; index < gainDbBuffer.length; index += 1) {
      gainDbBuffer[index] += bandCurve[index]
    }
  })

  return frequencies.map((frequencyHz, index) => ({
    frequencyHz,
    gainDb: gainDbBuffer[index],
  }))
}

export function sumCurveWithEq(baseCurve: CurvePoint[], eqCurve: CurvePoint[]) {
  return sumCurves(baseCurve, eqCurve)
}
