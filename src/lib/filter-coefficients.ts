import type { EqBand } from '../types'

export const DEFAULT_FILTER_Q = Math.SQRT1_2
export const DEFAULT_RESPONSE_SAMPLE_RATE = 48_000
const MIN_FREQUENCY_HZ = 20

export type FilterSection = {
  feedforward: [number, number, number]
  feedback: [number, number, number]
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
  return Math.max(0.05, value)
}

function getBandQ(band: EqBand) {
  return 'q' in band ? clampQ(band.q) : DEFAULT_FILTER_Q
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
  q: number,
) {
  const omega0 = getAngularFrequency(sampleRate, frequencyHz)
  const cosOmega = Math.cos(omega0)
  const sinOmega = Math.sin(omega0)
  const amplitude = 10 ** (gainDb / 40)
  const alpha = sinOmega / (2 * clampQ(q))
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
  q: number,
) {
  const omega0 = getAngularFrequency(sampleRate, frequencyHz)
  const cosOmega = Math.cos(omega0)
  const sinOmega = Math.sin(omega0)
  const amplitude = 10 ** (gainDb / 40)
  const alpha = sinOmega / (2 * clampQ(q))
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

function magnitudeToDb(magnitude: number) {
  return 20 * Math.log10(Math.max(1e-8, magnitude))
}

function getBellNyquistLimit(sampleRate: number) {
  return (sampleRate / 2) * 0.98
}

function getClampedBellFrequency(frequencyHz: number, sampleRate: number) {
  return Math.min(getBellNyquistLimit(sampleRate), Math.max(MIN_FREQUENCY_HZ, frequencyHz))
}

function findBellCrossingFrequency(
  section: FilterSection,
  sampleRate: number,
  centerFrequencyHz: number,
  targetMagnitude: number,
  direction: 'left' | 'right',
) {
  let outerBound =
    direction === 'left'
      ? MIN_FREQUENCY_HZ
      : getBellNyquistLimit(sampleRate)
  let innerBound = centerFrequencyHz
  const centerMagnitude = getSectionMagnitude(section, centerFrequencyHz, sampleRate)

  if (
    centerMagnitude <= targetMagnitude ||
    !Number.isFinite(centerMagnitude) ||
    !Number.isFinite(targetMagnitude)
  ) {
    return centerFrequencyHz
  }

  for (let iteration = 0; iteration < 32; iteration += 1) {
    const midLog =
      (Math.log10(outerBound) + Math.log10(innerBound)) / 2
    const candidate = 10 ** midLog
    const candidateMagnitude = getSectionMagnitude(section, candidate, sampleRate)

    if (candidateMagnitude > targetMagnitude) {
      innerBound = candidate
    } else {
      outerBound = candidate
    }
  }

  return direction === 'left' ? outerBound : innerBound
}

function getFlatTopBellEdgeFrequencies(
  band: Extract<EqBand, { type: 'peaking' }>,
  sampleRate: number,
) {
  const clampedFrequencyHz = getClampedBellFrequency(band.frequencyHz, sampleRate)
  const absoluteGainDb = Math.abs(band.gainDb)
  const baselineSection = designPeakingSection(
    sampleRate,
    clampedFrequencyHz,
    absoluteGainDb,
    band.q,
  )
  const targetMagnitude = 10 ** ((absoluteGainDb / 2) / 20)
  const leftFrequencyHz = findBellCrossingFrequency(
    baselineSection,
    sampleRate,
    clampedFrequencyHz,
    targetMagnitude,
    'left',
  )
  const rightFrequencyHz = findBellCrossingFrequency(
    baselineSection,
    sampleRate,
    clampedFrequencyHz,
    targetMagnitude,
    'right',
  )

  return {
    leftFrequencyHz,
    rightFrequencyHz,
  }
}

function createFlatTopBellSections(
  band: Extract<EqBand, { type: 'peaking' }>,
  sampleRate: number,
) {
  if (band.slopeDbPerOct === 12) {
    return [
      designPeakingSection(sampleRate, band.frequencyHz, band.gainDb, band.q),
    ]
  }

  const stageCount = band.slopeDbPerOct / 12
  const { leftFrequencyHz, rightFrequencyHz } = getFlatTopBellEdgeFrequencies(
    band,
    sampleRate,
  )
  const polarity = Math.sign(band.gainDb) || 1
  const targetGainDb = band.gainDb

  function buildSections(edgeGainDb: number) {
    const stageGainDb = edgeGainDb / stageCount

    return [
      ...Array.from({ length: stageCount }, () =>
        designHighShelfSection(
          sampleRate,
          leftFrequencyHz,
          polarity * stageGainDb,
          DEFAULT_FILTER_Q,
        ),
      ),
      ...Array.from({ length: stageCount }, () =>
        designHighShelfSection(
          sampleRate,
          rightFrequencyHz,
          -polarity * stageGainDb,
          DEFAULT_FILTER_Q,
        ),
      ),
    ]
  }

  let lowGainDb = Math.abs(targetGainDb)
  let highGainDb = Math.max(lowGainDb, 0.25)

  const getCenterGainDb = (edgeGainDb: number) =>
    magnitudeToDb(
      getCascadeMagnitudeResponse(
        buildSections(edgeGainDb),
        band.frequencyHz,
        sampleRate,
      ),
    )

  while (highGainDb < 96) {
    const centerGainDb = getCenterGainDb(highGainDb)
    if (
      (targetGainDb >= 0 && centerGainDb >= targetGainDb) ||
      (targetGainDb < 0 && centerGainDb <= targetGainDb)
    ) {
      break
    }
    highGainDb *= 1.5
  }

  for (let iteration = 0; iteration < 28; iteration += 1) {
    const midGainDb = (lowGainDb + highGainDb) / 2
    const centerGainDb = getCenterGainDb(midGainDb)

    if (
      (targetGainDb >= 0 && centerGainDb >= targetGainDb) ||
      (targetGainDb < 0 && centerGainDb <= targetGainDb)
    ) {
      highGainDb = midGainDb
    } else {
      lowGainDb = midGainDb
    }
  }

  return buildSections(highGainDb)
}

export function designBandSections(
  band: EqBand,
  sampleRate = DEFAULT_RESPONSE_SAMPLE_RATE,
) {
  const q = getBandQ(band)

  if (band.type === 'peaking') {
    return createFlatTopBellSections(band, sampleRate)
  }

  if (band.type === 'lowShelf') {
    const stageCount = band.slopeDbPerOct / 6
    return Array.from({ length: stageCount }, () =>
      designLowShelfSection(
        sampleRate,
        band.frequencyHz,
        band.gainDb / stageCount,
        q,
      ),
    )
  }

  if (band.type === 'highShelf') {
    const stageCount = band.slopeDbPerOct / 6
    return Array.from({ length: stageCount }, () =>
      designHighShelfSection(
        sampleRate,
        band.frequencyHz,
        band.gainDb / stageCount,
        q,
      ),
    )
  }

  if (band.type === 'lowCut') {
    return Array.from({ length: band.slopeDbPerOct / 12 }, () =>
      designHighpassSection(sampleRate, band.frequencyHz, DEFAULT_FILTER_Q),
    )
  }

  return Array.from({ length: band.slopeDbPerOct / 12 }, () =>
    designLowpassSection(sampleRate, band.frequencyHz, DEFAULT_FILTER_Q),
  )
}

function getSectionMagnitude(section: FilterSection, frequencyHz: number, sampleRate: number) {
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
