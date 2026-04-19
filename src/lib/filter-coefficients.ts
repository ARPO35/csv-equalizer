import type { EqBand, PeakingBand, ShelfBand } from '../types'

export const DEFAULT_FILTER_Q = Math.SQRT1_2
export const DEFAULT_RESPONSE_SAMPLE_RATE = 48_000

const MIN_Q = 0.05
const MIN_BANDWIDTH_OCTAVES = 0.05
const MIN_FREQUENCY = 20
const MAX_GAIN_SOLVER_DB = 48
const MAX_SHELF_SHAPE = 8
const MIN_SHELF_SHAPE = 0.125
const NYQUIST_MARGIN = 0.98
const LOG_2 = Math.log(2)

export type FilterSection = {
  feedforward: [number, number, number]
  feedback: [number, number, number]
}

export type DesignedSection = {
  key: string
  type: 'peaking' | 'lowshelf' | 'highshelf' | 'highpass' | 'lowpass'
  frequencyHz: number
  section: FilterSection
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

function clampQ(value: number) {
  return Math.max(MIN_Q, value)
}

function clampBandwidthOctaves(value: number) {
  return Math.max(MIN_BANDWIDTH_OCTAVES, value)
}

function clampFrequencyHz(frequencyHz: number, sampleRate: number) {
  return Math.min(
    sampleRate * 0.5 * NYQUIST_MARGIN,
    Math.max(MIN_FREQUENCY, frequencyHz),
  )
}

function clampShelfShape(value: number) {
  return Math.min(MAX_SHELF_SHAPE, Math.max(MIN_SHELF_SHAPE, value))
}

function getAngularFrequency(sampleRate: number, frequencyHz: number) {
  return (2 * Math.PI * clampFrequencyHz(frequencyHz, sampleRate)) / sampleRate
}

function qToBandwidthOctaves(q: number) {
  return clampBandwidthOctaves((2 * Math.asinh(1 / (2 * clampQ(q)))) / LOG_2)
}

function magnitudeToDb(magnitude: number) {
  return 20 * Math.log10(Math.max(magnitude, 1e-8))
}

function designPeakingSectionByBandwidth(
  sampleRate: number,
  frequencyHz: number,
  gainDb: number,
  bandwidthOctaves: number,
) {
  const omega0 = getAngularFrequency(sampleRate, frequencyHz)
  const cosOmega = Math.cos(omega0)
  const sinOmega = Math.sin(omega0)
  const amplitude = 10 ** (gainDb / 40)
  const alpha =
    Math.abs(sinOmega) < 1e-12
      ? 0
      : sinOmega *
        Math.sinh(
          (LOG_2 / 2) *
            clampBandwidthOctaves(bandwidthOctaves) *
            (omega0 / sinOmega),
        )

  return normalizeSection(
    1 + alpha * amplitude,
    -2 * cosOmega,
    1 - alpha * amplitude,
    1 + alpha / amplitude,
    -2 * cosOmega,
    1 - alpha / amplitude,
  )
}

function designPeakingSection(
  sampleRate: number,
  frequencyHz: number,
  gainDb: number,
  q: number,
) {
  return designPeakingSectionByBandwidth(
    sampleRate,
    frequencyHz,
    gainDb,
    qToBandwidthOctaves(q),
  )
}

function getShelfAlpha(
  sampleRate: number,
  frequencyHz: number,
  gainDb: number,
  shape: number,
) {
  const omega0 = getAngularFrequency(sampleRate, frequencyHz)
  const sinOmega = Math.sin(omega0)
  const amplitude = 10 ** (gainDb / 40)
  return (
    (sinOmega / 2) *
    Math.sqrt(
      (amplitude + 1 / amplitude) *
        (1 / clampShelfShape(shape) - 1) +
        2,
    )
  )
}

function designLowShelfSection(
  sampleRate: number,
  frequencyHz: number,
  gainDb: number,
  shape = 1,
) {
  const omega0 = getAngularFrequency(sampleRate, frequencyHz)
  const cosOmega = Math.cos(omega0)
  const amplitude = 10 ** (gainDb / 40)
  const alpha = getShelfAlpha(sampleRate, frequencyHz, gainDb, shape)
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
  shape = 1,
) {
  const omega0 = getAngularFrequency(sampleRate, frequencyHz)
  const cosOmega = Math.cos(omega0)
  const amplitude = 10 ** (gainDb / 40)
  const alpha = getShelfAlpha(sampleRate, frequencyHz, gainDb, shape)
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

function getResponseAtFrequencyHz(
  sections: FilterSection[],
  frequencyHz: number,
  sampleRate = DEFAULT_RESPONSE_SAMPLE_RATE,
) {
  return magnitudeToDb(
    getCascadeMagnitudeResponse(sections, frequencyHz, sampleRate),
  )
}

function solveFlatTopBellStageGainDb(
  sampleRate: number,
  lowerFrequencyHz: number,
  upperFrequencyHz: number,
  targetGainDb: number,
  shoulderShape: number,
) {
  const centerFrequencyHz = Math.sqrt(lowerFrequencyHz * upperFrequencyHz)
  const direction = Math.sign(targetGainDb) || 1
  const targetMagnitudeGainDb = Math.min(
    MAX_GAIN_SOLVER_DB,
    Math.max(0, Math.abs(targetGainDb)),
  )
  let low = 0
  let high = targetMagnitudeGainDb

  const getCenterGainDb = (stageGainMagnitudeDb: number) => {
    const sections = [
      designHighShelfSection(
        sampleRate,
        lowerFrequencyHz,
        direction * stageGainMagnitudeDb,
        shoulderShape,
      ),
      designHighShelfSection(
        sampleRate,
        upperFrequencyHz,
        direction * -stageGainMagnitudeDb,
        shoulderShape,
      ),
    ]

    return Math.abs(
      getResponseAtFrequencyHz(sections, centerFrequencyHz, sampleRate),
    )
  }

  while (
    Math.abs(getCenterGainDb(high)) < targetMagnitudeGainDb &&
    high < MAX_GAIN_SOLVER_DB
  ) {
    high = Math.min(MAX_GAIN_SOLVER_DB, high * 1.5)
  }

  for (let iteration = 0; iteration < 24; iteration += 1) {
    const middle = (low + high) / 2
    const centerGainDb = getCenterGainDb(middle)

    if (centerGainDb >= targetMagnitudeGainDb) {
      high = middle
    } else {
      low = middle
    }
  }

  return direction * high
}

function getBellShoulderShape(slopeDbPerOct: PeakingBand['slopeDbPerOct']) {
  switch (slopeDbPerOct) {
    case 24:
      return 2
    case 36:
      return 4
    case 48:
      return 8
    case 12:
      return 1
  }
}

function designPeakingTopology(
  band: PeakingBand,
  sampleRate = DEFAULT_RESPONSE_SAMPLE_RATE,
): DesignedSection[] {
  if (band.slopeDbPerOct === 12) {
    return [
      {
        key: `${band.id}:0`,
        type: 'peaking',
        frequencyHz: band.frequencyHz,
        section: designPeakingSection(
          sampleRate,
          band.frequencyHz,
          band.gainDb,
          band.q,
        ),
      },
    ]
  }

  const bandwidthOctaves = qToBandwidthOctaves(band.q)
  const lowerFrequencyHz = clampFrequencyHz(
    band.frequencyHz / 2 ** (bandwidthOctaves / 2),
    sampleRate,
  )
  const upperFrequencyHz = clampFrequencyHz(
    band.frequencyHz * 2 ** (bandwidthOctaves / 2),
    sampleRate,
  )

  if (upperFrequencyHz <= lowerFrequencyHz * 1.05) {
    return [
      {
        key: `${band.id}:fallback`,
        type: 'peaking',
        frequencyHz: band.frequencyHz,
        section: designPeakingSection(
          sampleRate,
          band.frequencyHz,
          band.gainDb,
          band.q,
        ),
      },
    ]
  }

  const shoulderShape = getBellShoulderShape(band.slopeDbPerOct)
  const stageGainDb = solveFlatTopBellStageGainDb(
    sampleRate,
    lowerFrequencyHz,
    upperFrequencyHz,
    band.gainDb,
    shoulderShape,
  )

  return [
    {
      key: `${band.id}:lower`,
      type: 'highshelf',
      frequencyHz: lowerFrequencyHz,
      section: designHighShelfSection(
        sampleRate,
        lowerFrequencyHz,
        stageGainDb,
        shoulderShape,
      ),
    },
    {
      key: `${band.id}:upper`,
      type: 'highshelf',
      frequencyHz: upperFrequencyHz,
      section: designHighShelfSection(
        sampleRate,
        upperFrequencyHz,
        -stageGainDb,
        shoulderShape,
      ),
    },
  ]
}

function designShelfTopology(
  band: ShelfBand,
  sampleRate = DEFAULT_RESPONSE_SAMPLE_RATE,
): DesignedSection[] {
  const stageCount = band.slopeDbPerOct / 6
  const stageGainDb = band.gainDb / stageCount
  const type = band.type === 'lowShelf' ? 'lowshelf' : 'highshelf'

  return Array.from({ length: stageCount }, (_, index) => ({
    key: `${band.id}:${index}`,
    type,
    frequencyHz: band.frequencyHz,
    section:
      type === 'lowshelf'
        ? designLowShelfSection(
            sampleRate,
            band.frequencyHz,
            stageGainDb,
            1,
          )
        : designHighShelfSection(
            sampleRate,
            band.frequencyHz,
            stageGainDb,
            1,
          ),
  }))
}

function designCutTopology(
  band: EqBand,
  sampleRate = DEFAULT_RESPONSE_SAMPLE_RATE,
): DesignedSection[] {
  const stageCount = band.slopeDbPerOct / 12
  const type = band.type === 'lowCut' ? 'highpass' : 'lowpass'

  return Array.from({ length: stageCount }, (_, index) => ({
    key: `${band.id}:${index}`,
    type,
    frequencyHz: band.frequencyHz,
    section:
      type === 'highpass'
        ? designHighpassSection(
            sampleRate,
            band.frequencyHz,
            DEFAULT_FILTER_Q,
          )
        : designLowpassSection(
            sampleRate,
            band.frequencyHz,
            DEFAULT_FILTER_Q,
          ),
  }))
}

export function designBandTopology(
  band: EqBand,
  sampleRate = DEFAULT_RESPONSE_SAMPLE_RATE,
): DesignedSection[] {
  switch (band.type) {
    case 'peaking':
      return designPeakingTopology(band, sampleRate)
    case 'lowShelf':
    case 'highShelf':
      return designShelfTopology(band, sampleRate)
    case 'lowCut':
    case 'highCut':
      return designCutTopology(band, sampleRate)
  }
}

export function designBandSections(
  band: EqBand,
  sampleRate = DEFAULT_RESPONSE_SAMPLE_RATE,
) {
  return designBandTopology(band, sampleRate).map(({ section }) => section)
}
