import {
  startTransition,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react'
import { createLogFrequencyGrid } from './curve'
import type { CurvePoint, EqBand, FftOverlay, SpectrumPoint } from '../types'

const CUT_Q = Math.SQRT1_2
const GRAPH_EQ_Q = 4.318
export const FFT_ANALYSER_MIN_DB = -96
export const FFT_ANALYSER_MAX_DB = 0
const FFT_ANALYSER_SIZE = 8192
const FFT_ANALYSER_SMOOTHING = 0.82
const FFT_OVERLAY_GRID_SIZE = 1024
const FFT_SMOOTHING_FRACTION = 24
const FFT_SMOOTHING_MIN_BIN_COUNT = 2
const GRAPH_EQ_CENTERS = [
  20,
  25,
  31.5,
  40,
  50,
  63,
  80,
  100,
  125,
  160,
  200,
  250,
  315,
  400,
  500,
  630,
  800,
  1000,
  1250,
  1600,
  2000,
  2500,
  3150,
  4000,
  5000,
  6300,
  8000,
  10000,
  12500,
  16000,
  20000,
]
const FFT_OVERLAY_FREQUENCIES = createLogFrequencyGrid(FFT_OVERLAY_GRID_SIZE)

type AudioContextConstructor = new () => AudioContext

type MonitorGraph = {
  source: MediaElementAudioSourceNode
  dryGain: GainNode
  wetInput: GainNode
  preGainNode: GainNode
  wetGain: GainNode
  preAnalyser: AnalyserNode
  postAnalyser: AnalyserNode
  filterNodes: BiquadFilterNode[]
}

type SpectrumBuffers = {
  pre: Float32Array<ArrayBuffer>
  post: Float32Array<ArrayBuffer>
}

function getAudioContextConstructor() {
  return (
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: AudioContextConstructor })
      .webkitAudioContext
  )
}

function safeDisconnect(node: AudioNode) {
  try {
    node.disconnect()
  } catch {
    // Ignore disconnect calls on already-detached nodes.
  }
}

function dbToLinear(db: number) {
  return 10 ** (db / 20)
}

function configureAnalyser(analyser: AnalyserNode) {
  analyser.fftSize = FFT_ANALYSER_SIZE
  analyser.minDecibels = FFT_ANALYSER_MIN_DB
  analyser.maxDecibels = FFT_ANALYSER_MAX_DB
  analyser.smoothingTimeConstant = FFT_ANALYSER_SMOOTHING
}

function getFftBinWidthHz(nyquistHz: number, binCount: number) {
  return nyquistHz / Math.max(1, binCount)
}

function getBandBounds(frequencyHz: number, fraction = FFT_SMOOTHING_FRACTION) {
  const ratio = 2 ** (1 / (fraction * 2))
  return {
    lowerHz: frequencyHz / ratio,
    upperHz: frequencyHz * ratio,
  }
}

function interpolateFrequencyLevelDb(
  frequencyData: Float32Array,
  nyquistHz: number,
  frequencyHz: number,
  floorDb: number,
) {
  if (frequencyData.length === 0 || nyquistHz <= 0) {
    return floorDb
  }

  const binWidthHz = getFftBinWidthHz(nyquistHz, frequencyData.length)
  const position = Math.min(
    frequencyData.length - 1,
    Math.max(0, frequencyHz / binWidthHz),
  )
  const leftIndex = Math.floor(position)
  const rightIndex = Math.min(frequencyData.length - 1, Math.ceil(position))
  const blend = position - leftIndex
  const leftValue = Number.isFinite(frequencyData[leftIndex])
    ? frequencyData[leftIndex]
    : floorDb
  const rightValue = Number.isFinite(frequencyData[rightIndex])
    ? frequencyData[rightIndex]
    : floorDb

  return leftValue + (rightValue - leftValue) * blend
}

function countBinsInBand(
  frequencyData: Float32Array,
  nyquistHz: number,
  lowerHz: number,
  upperHz: number,
) {
  if (frequencyData.length === 0 || upperHz <= lowerHz) {
    return 0
  }

  const binWidthHz = getFftBinWidthHz(nyquistHz, frequencyData.length)
  let count = 0

  for (let index = 0; index < frequencyData.length; index += 1) {
    const binFrequencyHz = index * binWidthHz
    if (binFrequencyHz >= lowerHz && binFrequencyHz <= upperHz) {
      count += 1
    }
  }

  return count
}

function createRawSpectrumTrace(
  frequencyData: Float32Array,
  nyquistHz: number,
  frequencies: number[],
  floorDb: number,
) {
  return frequencies.map((frequencyHz) => ({
    frequencyHz,
    levelDb: interpolateFrequencyLevelDb(
      frequencyData,
      nyquistHz,
      frequencyHz,
      floorDb,
    ),
  }))
}

function smoothSpectrumTrace(
  rawSpectrum: SpectrumPoint[],
  frequencyData: Float32Array,
  nyquistHz: number,
) {
  return rawSpectrum.map((point, index) => {
    const { lowerHz, upperHz } = getBandBounds(point.frequencyHz)
    const binCount = countBinsInBand(
      frequencyData,
      nyquistHz,
      lowerHz,
      upperHz,
    )

    if (binCount < FFT_SMOOTHING_MIN_BIN_COUNT) {
      return rawSpectrum[index]
    }

    let maxLevelDb = rawSpectrum[index].levelDb
    let matchedPointCount = 0

    for (let candidateIndex = 0; candidateIndex < rawSpectrum.length; candidateIndex += 1) {
      const candidate = rawSpectrum[candidateIndex]
      if (candidate.frequencyHz < lowerHz || candidate.frequencyHz > upperHz) {
        continue
      }

      matchedPointCount += 1
      if (candidate.levelDb > maxLevelDb) {
        maxLevelDb = candidate.levelDb
      }
    }

    return {
      frequencyHz: point.frequencyHz,
      levelDb: matchedPointCount === 0 ? point.levelDb : maxLevelDb,
    }
  })
}

function sampleCurveGain(curve: CurvePoint[], frequencyHz: number) {
  if (curve.length === 0) {
    return 0
  }

  if (frequencyHz <= curve[0].frequencyHz) {
    return curve[0].gainDb
  }

  if (frequencyHz >= curve[curve.length - 1].frequencyHz) {
    return curve[curve.length - 1].gainDb
  }

  for (let index = 0; index < curve.length - 1; index += 1) {
    const left = curve[index]
    const right = curve[index + 1]

    if (frequencyHz >= left.frequencyHz && frequencyHz <= right.frequencyHz) {
      const leftLog = Math.log10(left.frequencyHz)
      const rightLog = Math.log10(right.frequencyHz)
      const targetLog = Math.log10(frequencyHz)
      const ratio = (targetLog - leftLog) / (rightLog - leftLog)
      return left.gainDb + (right.gainDb - left.gainDb) * ratio
    }
  }

  return 0
}

function createFilterNodesForBand(context: AudioContext, band: EqBand) {
  const stageCount =
    band.type === 'lowCut' || band.type === 'highCut'
      ? band.slopeDbPerOct / 12
      : band.slopeDbPerOct / 6
  const stageGainDb = 'gainDb' in band ? band.gainDb / stageCount : undefined

  return Array.from({ length: stageCount }, () => {
    const filter = context.createBiquadFilter()
    filter.frequency.value = band.frequencyHz

    if (band.type === 'peaking') {
      filter.type = 'peaking'
      filter.gain.value = stageGainDb ?? band.gainDb
      filter.Q.value = band.q
      return filter
    }

    if (band.type === 'lowShelf' || band.type === 'highShelf') {
      filter.type = band.type === 'lowShelf' ? 'lowshelf' : 'highshelf'
      filter.gain.value = stageGainDb ?? band.gainDb
      return filter
    }

    filter.type = band.type === 'lowCut' ? 'highpass' : 'lowpass'
    filter.Q.value = CUT_Q
    return filter
  })
}

export function createGraphEqNodes(
  context: AudioContext,
  baselineCurve: CurvePoint[],
) {
  return GRAPH_EQ_CENTERS.map((center, index) => {
    const filter = context.createBiquadFilter()
    filter.frequency.value = center
    filter.gain.value = sampleCurveGain(baselineCurve, center)

    if (index === 0) {
      filter.type = 'lowshelf'
      return filter
    }

    if (index === GRAPH_EQ_CENTERS.length - 1) {
      filter.type = 'highshelf'
      return filter
    }

    filter.type = 'peaking'
    filter.Q.value = GRAPH_EQ_Q
    return filter
  })
}

export function createMonitorGraph(
  context: AudioContext,
  audioElement: HTMLAudioElement,
) {
  const source = context.createMediaElementSource(audioElement)
  const dryGain = context.createGain()
  const wetInput = context.createGain()
  const preGainNode = context.createGain()
  const wetGain = context.createGain()
  const preAnalyser = context.createAnalyser()
  const postAnalyser = context.createAnalyser()

  configureAnalyser(preAnalyser)
  configureAnalyser(postAnalyser)

  source.connect(dryGain)
  dryGain.connect(context.destination)
  source.connect(wetInput)
  wetGain.connect(context.destination)
  wetGain.connect(postAnalyser)

  return {
    source,
    dryGain,
    wetInput,
    preGainNode,
    wetGain,
    preAnalyser,
    postAnalyser,
    filterNodes: [],
  } satisfies MonitorGraph
}

export function syncMonitorGraph(
  context: AudioContext,
  graph: MonitorGraph,
  bands: EqBand[],
  baselineCurve: CurvePoint[],
  monitorBypassed: boolean,
  monitorBaselineEnabled: boolean,
  preGainDb: number,
) {
  safeDisconnect(graph.wetInput)
  safeDisconnect(graph.preGainNode)
  graph.filterNodes.forEach((node) => safeDisconnect(node))

  const shouldApplyEq = !monitorBypassed
  const baselineNodes =
    shouldApplyEq && monitorBaselineEnabled
      ? createGraphEqNodes(context, baselineCurve)
      : []
  const paramNodes = shouldApplyEq
    ? bands
        .filter((band) => !band.isBypassed)
        .flatMap((band) => createFilterNodesForBand(context, band))
    : []
  const filterNodes = [...baselineNodes, ...paramNodes]

  graph.wetInput.connect(graph.preGainNode)
  graph.preGainNode.connect(graph.preAnalyser)

  if (filterNodes.length === 0) {
    graph.preGainNode.connect(graph.wetGain)
  } else {
    graph.preGainNode.connect(filterNodes[0])

    filterNodes.forEach((node, index) => {
      const nextNode = filterNodes[index + 1] ?? graph.wetGain
      node.connect(nextNode)
    })
  }

  graph.preGainNode.gain.value = dbToLinear(preGainDb)
  graph.dryGain.gain.value = 0
  graph.wetGain.gain.value = 1
  graph.filterNodes = filterNodes
}

export function disconnectMonitorGraph(graph: MonitorGraph) {
  safeDisconnect(graph.source)
  safeDisconnect(graph.dryGain)
  safeDisconnect(graph.wetInput)
  safeDisconnect(graph.preGainNode)
  safeDisconnect(graph.wetGain)
  safeDisconnect(graph.preAnalyser)
  safeDisconnect(graph.postAnalyser)
  graph.filterNodes.forEach((node) => safeDisconnect(node))
}

export function mapFrequencyDataToSpectrum(
  frequencyData: Float32Array,
  nyquistHz: number,
  frequencies = FFT_OVERLAY_FREQUENCIES,
  floorDb = FFT_ANALYSER_MIN_DB,
): SpectrumPoint[] {
  if (frequencyData.length === 0 || nyquistHz <= 0) {
    return frequencies.map((frequencyHz) => ({
      frequencyHz,
      levelDb: floorDb,
    }))
  }

  const rawSpectrum = createRawSpectrumTrace(
    frequencyData,
    nyquistHz,
    frequencies,
    floorDb,
  )

  return smoothSpectrumTrace(rawSpectrum, frequencyData, nyquistHz)
}

function ensureSpectrumBuffers(
  buffers: SpectrumBuffers | null,
  graph: MonitorGraph,
) {
  const expectedSize = graph.preAnalyser.frequencyBinCount
  if (
    !buffers ||
    buffers.pre.length !== expectedSize ||
    buffers.post.length !== graph.postAnalyser.frequencyBinCount
  ) {
    return {
      pre: new Float32Array(expectedSize),
      post: new Float32Array(graph.postAnalyser.frequencyBinCount),
    }
  }

  return buffers
}

function readFftOverlay(
  graph: MonitorGraph,
  sampleRate: number,
  buffers: SpectrumBuffers,
): FftOverlay {
  graph.preAnalyser.getFloatFrequencyData(buffers.pre)
  graph.postAnalyser.getFloatFrequencyData(buffers.post)

  const nyquistHz = sampleRate / 2

  return {
    preSpectrum: mapFrequencyDataToSpectrum(buffers.pre, nyquistHz),
    postSpectrum: mapFrequencyDataToSpectrum(buffers.post, nyquistHz),
  }
}

export function useEqPlaybackMonitor({
  audioElement,
  bands,
  baselineCurve,
  monitorBypassed,
  monitorBaselineEnabled,
  preGainDb,
}: {
  audioElement: HTMLAudioElement | null
  bands: EqBand[]
  baselineCurve: CurvePoint[]
  monitorBypassed: boolean
  monitorBaselineEnabled: boolean
  preGainDb: number
}) {
  const audioContextRef = useRef<AudioContext | null>(null)
  const graphRef = useRef<MonitorGraph | null>(null)
  const attachedElementRef = useRef<HTMLAudioElement | null>(null)
  const spectrumBuffersRef = useRef<SpectrumBuffers | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [fftOverlay, setFftOverlay] = useState<FftOverlay | null>(null)

  const clearFftOverlay = useEffectEvent(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }

    startTransition(() => {
      setFftOverlay(null)
    })
  })

  const sampleFftOverlay = useEffectEvent(() => {
    const context = audioContextRef.current
    const graph = graphRef.current
    const attachedElement = attachedElementRef.current

    if (
      !context ||
      !graph ||
      !attachedElement ||
      attachedElement.paused ||
      attachedElement.ended
    ) {
      clearFftOverlay()
      return
    }

    spectrumBuffersRef.current = ensureSpectrumBuffers(
      spectrumBuffersRef.current,
      graph,
    )

    const nextOverlay = readFftOverlay(
      graph,
      context.sampleRate,
      spectrumBuffersRef.current,
    )

    startTransition(() => {
      setFftOverlay(nextOverlay)
    })

    animationFrameRef.current = requestAnimationFrame(sampleFftOverlay)
  })

  const startFftOverlay = useEffectEvent(() => {
    const context = audioContextRef.current
    const attachedElement = attachedElementRef.current

    if (!context || !attachedElement || attachedElement.paused) {
      return
    }

    if (context.state === 'suspended') {
      void context.resume()
    }

    if (animationFrameRef.current !== null) {
      return
    }

    sampleFftOverlay()
  })

  useEffect(() => {
    if (!audioElement || attachedElementRef.current === audioElement) {
      return
    }

    const ContextConstructor = getAudioContextConstructor()
    if (!ContextConstructor) {
      setErrorMessage('This browser cannot monitor audio through Web Audio.')
      return
    }

    try {
      const context = audioContextRef.current ?? new ContextConstructor()
      const graph = createMonitorGraph(context, audioElement)

      audioContextRef.current = context
      graphRef.current = graph
      attachedElementRef.current = audioElement
      spectrumBuffersRef.current = null
      setErrorMessage(null)
      setFftOverlay(null)

      const resumeContext = () => {
        if (context.state === 'suspended') {
          void context.resume()
        }
      }

      audioElement.addEventListener('play', resumeContext)

      return () => {
        audioElement.removeEventListener('play', resumeContext)
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to initialize the monitor audio graph.'
      setErrorMessage(message)
    }
  }, [audioElement])

  useEffect(() => {
    const context = audioContextRef.current
    const graph = graphRef.current

    if (!context || !graph) {
      return
    }

    syncMonitorGraph(
      context,
      graph,
      bands,
      baselineCurve,
      monitorBypassed,
      monitorBaselineEnabled,
      preGainDb,
    )
    setErrorMessage(null)
  }, [bands, baselineCurve, monitorBaselineEnabled, monitorBypassed, preGainDb])

  useEffect(() => {
    if (!audioElement) {
      clearFftOverlay()
      return
    }

    const handlePlay = () => {
      startFftOverlay()
    }
    const handleStop = () => {
      clearFftOverlay()
    }

    audioElement.addEventListener('play', handlePlay)
    audioElement.addEventListener('pause', handleStop)
    audioElement.addEventListener('ended', handleStop)
    audioElement.addEventListener('emptied', handleStop)

    if (!audioElement.paused) {
      startFftOverlay()
    }

    return () => {
      audioElement.removeEventListener('play', handlePlay)
      audioElement.removeEventListener('pause', handleStop)
      audioElement.removeEventListener('ended', handleStop)
      audioElement.removeEventListener('emptied', handleStop)
      clearFftOverlay()
    }
  }, [audioElement, clearFftOverlay, startFftOverlay])

  useEffect(() => {
    return () => {
      clearFftOverlay()

      const graph = graphRef.current
      if (graph) {
        disconnectMonitorGraph(graph)
      }

      if (audioContextRef.current) {
        void audioContextRef.current.close()
      }
    }
  }, [])

  return {
    errorMessage,
    fftOverlay,
  }
}
