import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { BandUpdateMode, EqBand } from '../types'

export const BAND_SMOOTHING_DURATION_MS = 50

type BandAnimation = {
  frameId: number
  lastTimestamp: number
  targetBands: EqBand[]
}

function lerp(startValue: number, endValue: number, progress: number) {
  return startValue + (endValue - startValue) * progress
}

const PROPORTIONAL_SETTLE_RATIO = 0.01
const FREQUENCY_LOG_EPSILON = 0.001
const GAIN_EPSILON = 0.01
const Q_EPSILON = 0.01
const SMOOTHING_RATE =
  -Math.log(PROPORTIONAL_SETTLE_RATIO) / BAND_SMOOTHING_DURATION_MS

function lerpFrequencyLogDomain(
  startFrequencyHz: number,
  endFrequencyHz: number,
  progress: number,
) {
  const startLog = Math.log10(startFrequencyHz)
  const endLog = Math.log10(endFrequencyHz)
  return 10 ** lerp(startLog, endLog, progress)
}

function isFrequencyClose(leftFrequencyHz: number, rightFrequencyHz: number) {
  return Math.abs(Math.log10(leftFrequencyHz / rightFrequencyHz)) <= FREQUENCY_LOG_EPSILON
}

export function areBandsEqual(left: EqBand[], right: EqBand[]) {
  if (left.length !== right.length) {
    return false
  }

  return left.every((band, index) => {
    const otherBand = right[index]
    if (!otherBand) {
      return false
    }

    if (
      band.id !== otherBand.id ||
      band.type !== otherBand.type ||
      band.frequencyHz !== otherBand.frequencyHz ||
      band.isBypassed !== otherBand.isBypassed ||
      band.slopeDbPerOct !== otherBand.slopeDbPerOct
    ) {
      return false
    }

    if ('gainDb' in band !== 'gainDb' in otherBand) {
      return false
    }

    if ('gainDb' in band && 'gainDb' in otherBand && band.gainDb !== otherBand.gainDb) {
      return false
    }

    if ('q' in band !== 'q' in otherBand) {
      return false
    }

    if ('q' in band && 'q' in otherBand && band.q !== otherBand.q) {
      return false
    }

    return true
  })
}

export function haveCompatibleBandTopology(left: EqBand[], right: EqBand[]) {
  if (left.length !== right.length) {
    return false
  }

  return left.every((band, index) => {
    const otherBand = right[index]
    return Boolean(
      otherBand &&
        band.id === otherBand.id &&
        band.type === otherBand.type &&
        band.isBypassed === otherBand.isBypassed &&
        band.slopeDbPerOct === otherBand.slopeDbPerOct,
    )
  })
}

function areBandsClose(
  leftBands: EqBand[],
  rightBands: EqBand[],
) {
  if (leftBands.length !== rightBands.length) {
    return false
  }

  return leftBands.every((band, index) => {
    const otherBand = rightBands[index]
    if (!otherBand) {
      return false
    }

    if (
      band.id !== otherBand.id ||
      band.type !== otherBand.type ||
      band.isBypassed !== otherBand.isBypassed ||
      band.slopeDbPerOct !== otherBand.slopeDbPerOct
    ) {
      return false
    }

    if (!isFrequencyClose(band.frequencyHz, otherBand.frequencyHz)) {
      return false
    }

    if (band.type === 'peaking' && otherBand.type === 'peaking') {
      return (
        Math.abs(band.gainDb - otherBand.gainDb) <= GAIN_EPSILON &&
        Math.abs(band.q - otherBand.q) <= Q_EPSILON
      )
    }

    if (
      (band.type === 'lowShelf' || band.type === 'highShelf') &&
      band.type === otherBand.type
    ) {
      return Math.abs(band.gainDb - otherBand.gainDb) <= GAIN_EPSILON
    }

    if (
      (band.type === 'lowCut' || band.type === 'highCut') &&
      band.type === otherBand.type
    ) {
      return true
    }

    return false
  })
}

function chaseBands(
  currentBands: EqBand[],
  targetBands: EqBand[],
  alpha: number,
) {
  return currentBands.map((band, index) => {
    const targetBand = targetBands[index]
    if (!targetBand) {
      return band
    }

    if (band.type === 'peaking' && targetBand.type === 'peaking') {
      return {
        ...band,
        frequencyHz: lerpFrequencyLogDomain(
          band.frequencyHz,
          targetBand.frequencyHz,
          alpha,
        ),
        gainDb: lerp(band.gainDb, targetBand.gainDb, alpha),
        q: lerp(band.q, targetBand.q, alpha),
      }
    }

    if (
      (band.type === 'lowShelf' || band.type === 'highShelf') &&
      band.type === targetBand.type
    ) {
      return {
        ...band,
        frequencyHz: lerpFrequencyLogDomain(
          band.frequencyHz,
          targetBand.frequencyHz,
          alpha,
        ),
        gainDb: lerp(band.gainDb, targetBand.gainDb, alpha),
      }
    }

    if (
      (band.type === 'lowCut' || band.type === 'highCut') &&
      band.type === targetBand.type
    ) {
      return {
        ...band,
        frequencyHz: lerpFrequencyLogDomain(
          band.frequencyHz,
          targetBand.frequencyHz,
          alpha,
        ),
      }
    }

    return targetBand
  })
}

export function useAppliedBands(targetBands: EqBand[]) {
  const [appliedBands, setAppliedBands] = useState(targetBands)
  const appliedBandsRef = useRef(targetBands)
  const nextChangeModeRef = useRef<BandUpdateMode>('immediate')
  const animationRef = useRef<BandAnimation | null>(null)
  const animationStepRef = useRef<(timestamp: number) => void>(() => undefined)

  const commitAppliedBands = useCallback((nextBands: EqBand[]) => {
    appliedBandsRef.current = nextBands
    setAppliedBands(nextBands)
  }, [])

  const stopAnimation = useCallback(() => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current.frameId)
      animationRef.current = null
    }
  }, [])

  const flushAppliedBands = useCallback(() => {
    stopAnimation()
    commitAppliedBands(targetBands)
  }, [commitAppliedBands, stopAnimation, targetBands])

  const markNextBandChange = useCallback((mode: BandUpdateMode) => {
    nextChangeModeRef.current = mode
  }, [])

  animationStepRef.current = (timestamp: number) => {
    const animation = animationRef.current
    if (!animation) {
      return
    }

    const elapsedMs = Math.max(0, timestamp - animation.lastTimestamp)
    const alpha = 1 - Math.exp(-SMOOTHING_RATE * elapsedMs)
    const nextBands = chaseBands(
      appliedBandsRef.current,
      animation.targetBands,
      alpha,
    )

    if (areBandsClose(nextBands, animation.targetBands)) {
      animationRef.current = null
      commitAppliedBands(animation.targetBands)
      return
    }

    commitAppliedBands(nextBands)

    animationRef.current = {
      ...animation,
      lastTimestamp: timestamp,
      frameId: requestAnimationFrame(animationStepRef.current),
    }
  }

  useEffect(() => {
    const nextMode = nextChangeModeRef.current
    nextChangeModeRef.current = 'immediate'

    if (areBandsEqual(appliedBandsRef.current, targetBands)) {
      stopAnimation()
      commitAppliedBands(targetBands)
      return
    }

    if (
      nextMode !== 'smooth' ||
      !haveCompatibleBandTopology(appliedBandsRef.current, targetBands)
    ) {
      stopAnimation()
      commitAppliedBands(targetBands)
      return
    }

    const now = performance.now()
    if (animationRef.current) {
      animationRef.current = {
        ...animationRef.current,
        lastTimestamp: now,
        targetBands,
      }
      return
    }

    animationRef.current = {
      frameId: requestAnimationFrame(animationStepRef.current),
      lastTimestamp: now,
      targetBands,
    }
  }, [commitAppliedBands, stopAnimation, targetBands])

  useEffect(() => stopAnimation, [stopAnimation])

  return {
    appliedBands,
    flushAppliedBands,
    markNextBandChange,
  }
}
