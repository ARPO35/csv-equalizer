import type { EqBand } from '../types'

export const DEFAULT_FILTER_Q = Math.SQRT1_2
export const DEFAULT_RESPONSE_SAMPLE_RATE = 48_000

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

function getBandStageCount(band: EqBand) {
  if (band.type === 'lowCut' || band.type === 'highCut') {
    return band.slopeDbPerOct / 12
  }

  return band.slopeDbPerOct / 6
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

export function designBandSections(
  band: EqBand,
  sampleRate = DEFAULT_RESPONSE_SAMPLE_RATE,
) {
  const stageCount = getBandStageCount(band)
  const q = getBandQ(band)

  return Array.from({ length: stageCount }, () => {
    if (band.type === 'peaking') {
      return designPeakingSection(
        sampleRate,
        band.frequencyHz,
        band.gainDb / stageCount,
        q,
      )
    }

    if (band.type === 'lowShelf') {
      return designLowShelfSection(
        sampleRate,
        band.frequencyHz,
        band.gainDb / stageCount,
        q,
      )
    }

    if (band.type === 'highShelf') {
      return designHighShelfSection(
        sampleRate,
        band.frequencyHz,
        band.gainDb / stageCount,
        q,
      )
    }

    if (band.type === 'lowCut') {
      return designHighpassSection(sampleRate, band.frequencyHz, DEFAULT_FILTER_Q)
    }

    return designLowpassSection(sampleRate, band.frequencyHz, DEFAULT_FILTER_Q)
  })
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
