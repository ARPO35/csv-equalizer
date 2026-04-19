import type { EqBand, PeakingBand, ShelfBand } from '../types'

export const DEFAULT_FILTER_Q = Math.SQRT1_2
export const DEFAULT_RESPONSE_SAMPLE_RATE = 48_000
const MIN_Q = 0.05
const MIN_BANDWIDTH_OCTAVES = 0.05
const MAX_SOLVER_GAIN_DB = 48
export type FilterSection = {
  feedforward: [number, number, number]
  feedback: [number, number, number]
}

export type FilterDescriptor = {
  key: string
  type: 'peaking' | 'lowshelf' | 'highshelf' | 'highpass' | 'lowpass'
  frequencyHz: number
  gainDb?: number
  q?: number
}

function normalizeSection(
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number,
): FilterSection {
  return {
    feedforward: [b0 / a0, b1 / a0, b2 / a0],
    feedback: [1, a1 / a0, a2 / a0],
  }
}

function getAngularFrequency(sampleRate: number, frequencyHz: number) {
  return (2 * Math.PI * frequencyHz) / sampleRate
}

function clampQ(value: number) {
  return Math.max(MIN_Q, value)
}

function clampBandwidthOctaves(value: number) {
  return Math.max(MIN_BANDWIDTH_OCTAVES, value)
}

function clampMagnitudeGainDb(value: number) {
  return Math.min(MAX_SOLVER_GAIN_DB, Math.max(0, value))
}

function magnitudeToDb(magnitude: number) {
  return 20 * Math.log10(Math.max(magnitude, 1e-8))
}

function getFlatTopBellFrequencies(
  centerFrequencyHz: number,
  bandwidthOctaves: number,
  count: number,
) {
  if (count <= 1) {
    return [centerFrequencyHz]
  }

  const halfBandwidthOctaves = clampBandwidthOctaves(bandwidthOctaves) / 2
  const pairCount = count - 1
  const offsets = Array.from({ length: pairCount }, (_, index) =>
    halfBandwidthOctaves * (((index + 1) / (pairCount + 1)) * 0.5),
  )

  return [
    ...offsets.map((offset) => centerFrequencyHz * 2 ** -offset),
    centerFrequencyHz,
    ...offsets.map((offset) => centerFrequencyHz * 2 ** offset),
  ]
}

function getBandwidthOctaves(lowerFrequencyHz: number, upperFrequencyHz: number) {
  return clampBandwidthOctaves(Math.log2(upperFrequencyHz / lowerFrequencyHz))
}

function designPeakingSection(
  sampleRate: number,
  frequencyHz: number,
  gainDb: number,
  q: number,
) {
  const omega0 = getAngularFrequency(sampleRate, frequencyHz)
  const cosOmega = Math.cos(omega0)
  const sinOmega = Math.sin(omega0)
  const alpha = sinOmega / (2 * clampQ(q))
  const amplitude = 10 ** (gainDb / 40)

  return normalizeSection(
    1 + alpha * amplitude,
    -2 * cosOmega,
    1 - alpha * amplitude,
    1 + alpha / amplitude,
    -2 * cosOmega,
    1 - alpha / amplitude,
  )
}

function designLowShelfSection(
  sampleRate: number,
  frequencyHz: number,
  gainDb: number,
) {
  const omega0 = getAngularFrequency(sampleRate, frequencyHz)
  const cosOmega = Math.cos(omega0)
  const sinOmega = Math.sin(omega0)
  const amplitude = 10 ** (gainDb / 40)
  const alpha = sinOmega / (2 * DEFAULT_FILTER_Q)
  const twoSqrtAmplitudeAlpha = 2 * Math.sqrt(amplitude) * alpha

  return normalizeSection(
    amplitude *
      ((amplitude + 1) - (amplitude - 1) * cosOmega + twoSqrtAmplitudeAlpha),
    2 *
      amplitude *
      ((amplitude - 1) - (amplitude + 1) * cosOmega),
    amplitude *
      ((amplitude + 1) - (amplitude - 1) * cosOmega - twoSqrtAmplitudeAlpha),
    (amplitude + 1) + (amplitude - 1) * cosOmega + twoSqrtAmplitudeAlpha,
    -2 * ((amplitude - 1) + (amplitude + 1) * cosOmega),
    (amplitude + 1) + (amplitude - 1) * cosOmega - twoSqrtAmplitudeAlpha,
  )
}

function designHighShelfSection(
  sampleRate: number,
  frequencyHz: number,
  gainDb: number,
) {
  const omega0 = getAngularFrequency(sampleRate, frequencyHz)
  const cosOmega = Math.cos(omega0)
  const sinOmega = Math.sin(omega0)
  const amplitude = 10 ** (gainDb / 40)
  const alpha = sinOmega / (2 * DEFAULT_FILTER_Q)
  const twoSqrtAmplitudeAlpha = 2 * Math.sqrt(amplitude) * alpha

  return normalizeSection(
    amplitude *
      ((amplitude + 1) + (amplitude - 1) * cosOmega + twoSqrtAmplitudeAlpha),
    -2 *
      amplitude *
      ((amplitude - 1) + (amplitude + 1) * cosOmega),
    amplitude *
      ((amplitude + 1) + (amplitude - 1) * cosOmega - twoSqrtAmplitudeAlpha),
    (amplitude + 1) - (amplitude - 1) * cosOmega + twoSqrtAmplitudeAlpha,
    2 * ((amplitude - 1) - (amplitude + 1) * cosOmega),
    (amplitude + 1) - (amplitude - 1) * cosOmega - twoSqrtAmplitudeAlpha,
  )
}

function designHighpassSection(sampleRate: number, frequencyHz: number, q: number) {
  const omega0 = getAngularFrequency(sampleRate, frequencyHz)
  const cosOmega = Math.cos(omega0)
  const sinOmega = Math.sin(omega0)
  const alpha = sinOmega / (2 * clampQ(q))

  return normalizeSection(
    (1 + cosOmega) / 2,
    -(1 + cosOmega),
    (1 + cosOmega) / 2,
    1 + alpha,
    -2 * cosOmega,
    1 - alpha,
  )
}

function designLowpassSection(sampleRate: number, frequencyHz: number, q: number) {
  const omega0 = getAngularFrequency(sampleRate, frequencyHz)
  const cosOmega = Math.cos(omega0)
  const sinOmega = Math.sin(omega0)
  const alpha = sinOmega / (2 * clampQ(q))

  return normalizeSection(
    (1 - cosOmega) / 2,
    1 - cosOmega,
    (1 - cosOmega) / 2,
    1 + alpha,
    -2 * cosOmega,
    1 - alpha,
  )
}

function getSectionMagnitude(
  section: FilterSection,
  frequencyHz: number,
  sampleRate: number,
) {
  const omega = getAngularFrequency(sampleRate, frequencyHz)
  const cosOmega = Math.cos(omega)
  const sinOmega = Math.sin(omega)
  const cosTwoOmega = Math.cos(omega * 2)
  const sinTwoOmega = Math.sin(omega * 2)
  const [b0, b1, b2] = section.feedforward
  const [, a1, a2] = section.feedback

  const numeratorReal = b0 + b1 * cosOmega + b2 * cosTwoOmega
  const numeratorImag = -(b1 * sinOmega + b2 * sinTwoOmega)
  const denominatorReal = 1 + a1 * cosOmega + a2 * cosTwoOmega
  const denominatorImag = -(a1 * sinOmega + a2 * sinTwoOmega)
  const numeratorMagnitude = Math.hypot(numeratorReal, numeratorImag)
  const denominatorMagnitude = Math.hypot(denominatorReal, denominatorImag)

  return denominatorMagnitude === 0
    ? 0
    : numeratorMagnitude / denominatorMagnitude
}

export function getCascadeMagnitudeResponse(
  sections: FilterSection[],
  frequencyHz: number,
  sampleRate = DEFAULT_RESPONSE_SAMPLE_RATE,
) {
  return sections.reduce(
    (magnitude, section) =>
      magnitude * getSectionMagnitude(section, frequencyHz, sampleRate),
    1,
  )
}

function descriptorToSection(
  descriptor: FilterDescriptor,
  sampleRate = DEFAULT_RESPONSE_SAMPLE_RATE,
) {
  switch (descriptor.type) {
    case 'peaking':
      return designPeakingSection(
        sampleRate,
        descriptor.frequencyHz,
        descriptor.gainDb ?? 0,
        descriptor.q ?? DEFAULT_FILTER_Q,
      )
    case 'lowshelf':
      return designLowShelfSection(
        sampleRate,
        descriptor.frequencyHz,
        descriptor.gainDb ?? 0,
      )
    case 'highshelf':
      return designHighShelfSection(
        sampleRate,
        descriptor.frequencyHz,
        descriptor.gainDb ?? 0,
      )
    case 'highpass':
      return designHighpassSection(
        sampleRate,
        descriptor.frequencyHz,
        descriptor.q ?? DEFAULT_FILTER_Q,
      )
    case 'lowpass':
      return designLowpassSection(
        sampleRate,
        descriptor.frequencyHz,
        descriptor.q ?? DEFAULT_FILTER_Q,
      )
  }
}

function getResponseAtFrequencyHz(
  descriptors: FilterDescriptor[],
  frequencyHz: number,
  sampleRate = DEFAULT_RESPONSE_SAMPLE_RATE,
) {
  return magnitudeToDb(
    getCascadeMagnitudeResponse(
      descriptors.map((descriptor) => descriptorToSection(descriptor, sampleRate)),
      frequencyHz,
      sampleRate,
    ),
  )
}

function findFrequencyForTargetGain(
  descriptors: FilterDescriptor[],
  minFrequencyHz: number,
  maxFrequencyHz: number,
  targetGainDb: number,
  sampleRate = DEFAULT_RESPONSE_SAMPLE_RATE,
) {
  let low = Math.log(minFrequencyHz)
  let high = Math.log(maxFrequencyHz)

  for (let iteration = 0; iteration < 32; iteration += 1) {
    const middle = (low + high) / 2
    const frequencyHz = Math.exp(middle)
    const gainDb = getResponseAtFrequencyHz(descriptors, frequencyHz, sampleRate)

    if (gainDb > targetGainDb) {
      high = middle
    } else {
      low = middle
    }
  }

  return Math.exp((low + high) / 2)
}

function getBellHalfGainEdges(
  band: PeakingBand,
  sampleRate = DEFAULT_RESPONSE_SAMPLE_RATE,
) {
  const baselineDescriptor: FilterDescriptor = {
    key: `${band.id}:baseline`,
    type: 'peaking',
    frequencyHz: band.frequencyHz,
    gainDb: band.gainDb,
    q: band.q,
  }
  const targetGainDb = band.gainDb / 2

  return {
    lowerFrequencyHz: findFrequencyForTargetGain(
      [baselineDescriptor],
      Math.max(20, band.frequencyHz / 32),
      band.frequencyHz,
      targetGainDb,
      sampleRate,
    ),
    upperFrequencyHz: findFrequencyForTargetGain(
      [baselineDescriptor],
      band.frequencyHz,
      Math.min(20_000, band.frequencyHz * 32),
      targetGainDb,
      sampleRate,
    ),
  }
}

function solveBellStageGainDb(
  centers: number[],
  q: number,
  band: PeakingBand,
  sampleRate = DEFAULT_RESPONSE_SAMPLE_RATE,
) {
  const direction = Math.sign(band.gainDb) || 1
  const targetMagnitudeGainDb = clampMagnitudeGainDb(Math.abs(band.gainDb))
  let low = 0
  let high = targetMagnitudeGainDb

  const getCenterGainDb = (stageGainDbMagnitude: number) =>
    getResponseAtFrequencyHz(
      centers.map((frequencyHz, index) => ({
        key: `${band.id}:${index}`,
        type: 'peaking' as const,
        frequencyHz,
        gainDb: direction * stageGainDbMagnitude,
        q,
      })),
      band.frequencyHz,
      sampleRate,
    )

  while (Math.abs(getCenterGainDb(high)) < targetMagnitudeGainDb && high < MAX_SOLVER_GAIN_DB) {
    high = Math.min(MAX_SOLVER_GAIN_DB, high * 1.5)
  }

  for (let iteration = 0; iteration < 24; iteration += 1) {
    const middle = (low + high) / 2
    const centerGainDb = Math.abs(getCenterGainDb(middle))

    if (centerGainDb >= targetMagnitudeGainDb) {
      high = middle
    } else {
      low = middle
    }
  }

  return direction * high
}

function designPeakingDescriptors(
  band: PeakingBand,
  sampleRate = DEFAULT_RESPONSE_SAMPLE_RATE,
) {
  if (band.slopeDbPerOct === 12) {
    return [
      {
        key: `${band.id}:0`,
        type: 'peaking' as const,
        frequencyHz: band.frequencyHz,
        gainDb: band.gainDb,
        q: band.q,
      },
    ]
  }

  const stageCount = band.slopeDbPerOct / 12
  const { lowerFrequencyHz, upperFrequencyHz } = getBellHalfGainEdges(
    band,
    sampleRate,
  )
  const bandwidthOctaves = getBandwidthOctaves(
    lowerFrequencyHz,
    upperFrequencyHz,
  )
  const centers = getFlatTopBellFrequencies(
    band.frequencyHz,
    bandwidthOctaves,
    stageCount,
  )
  const stageQ = band.q * Math.sqrt(stageCount)
  const stageGainDb = solveBellStageGainDb(centers, stageQ, band, sampleRate)

  return centers.map((frequencyHz, index) => ({
    key: `${band.id}:${index}`,
    type: 'peaking' as const,
    frequencyHz,
    gainDb: stageGainDb,
    q: stageQ,
  }))
}

function designShelfDescriptors(band: ShelfBand) {
  const stageCount = band.slopeDbPerOct / 6
  const stageGainDb = band.gainDb / stageCount
  const shelfType = band.type === 'lowShelf' ? 'lowshelf' : 'highshelf'
  return Array.from({ length: stageCount }, (_, index) => ({
    key: `${band.id}:shelf:${index}`,
    type: shelfType,
    frequencyHz: band.frequencyHz,
    gainDb: stageGainDb,
  })) satisfies FilterDescriptor[]
}

function designCutDescriptors(band: EqBand) {
  const stageCount = band.slopeDbPerOct / 12
  const type = band.type === 'lowCut' ? 'highpass' : 'lowpass'

  return Array.from({ length: stageCount }, (_, index) => ({
    key: `${band.id}:${index}`,
    type,
    frequencyHz: band.frequencyHz,
    q: DEFAULT_FILTER_Q,
  })) satisfies FilterDescriptor[]
}

export function designBandDescriptors(
  band: EqBand,
  sampleRate = DEFAULT_RESPONSE_SAMPLE_RATE,
): FilterDescriptor[] {
  switch (band.type) {
    case 'peaking':
      return designPeakingDescriptors(band, sampleRate)
    case 'lowShelf':
    case 'highShelf':
      return designShelfDescriptors(band)
    case 'lowCut':
    case 'highCut':
      return designCutDescriptors(band)
  }
}

export function designBandSections(
  band: EqBand,
  sampleRate = DEFAULT_RESPONSE_SAMPLE_RATE,
) {
  return designBandDescriptors(band, sampleRate).map((descriptor) =>
    descriptorToSection(descriptor, sampleRate),
  )
}
