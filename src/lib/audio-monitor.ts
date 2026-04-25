import { useCallback, useEffect, useRef, useState } from 'react'
import { createLogFrequencyGrid } from './curve'
import type { CurvePoint, EqBand, SpectrumPoint } from '../types'

const CUT_Q = Math.SQRT1_2
const GRAPH_EQ_Q = 4.318
export const FFT_ANALYSER_MIN_DB = -96
export const FFT_ANALYSER_MAX_DB = 0
export const DEFAULT_FFT_SIZE = 8192
export const FFT_SIZE_OPTIONS = [32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768] as const
const FFT_ANALYSER_SMOOTHING = 0.82
const FFT_OVERLAY_GRID_SIZE = 1024
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
  filterDescriptors: FilterDescriptor[]
  isConfigured: boolean
}

type FilterDescriptor = {
  key: string
  type: BiquadFilterType
  frequencyHz: number
  gainDb?: number
  q?: number
}

type SpectrumBuffers = {
  pre: Float32Array
  post: Float32Array
}

type FftStoreListener = () => void

export type FftFrameSnapshot = {
  version: number
  hasData: boolean
  sampleRate: number
  frequencies: Float32Array
  preLevels: Float32Array
  postLevels: Float32Array
}

export type FftOverlayStore = {
  getSnapshot: () => FftFrameSnapshot
  subscribe: (listener: FftStoreListener) => () => void
}

type MutableFftOverlayStore = FftOverlayStore & {
  publish: (sampleRate: number, buffers: SpectrumBuffers) => void
  clear: () => void
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

function configureAnalyser(analyser: AnalyserNode, fftSize = DEFAULT_FFT_SIZE) {
  analyser.fftSize = fftSize
  analyser.minDecibels = FFT_ANALYSER_MIN_DB
  analyser.maxDecibels = FFT_ANALYSER_MAX_DB
  analyser.smoothingTimeConstant = FFT_ANALYSER_SMOOTHING
}

function getFftBinWidthHz(nyquistHz: number, binCount: number) {
  return nyquistHz / Math.max(1, binCount)
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

function fillSpectrumLevels(
  frequencyData: Float32Array,
  nyquistHz: number,
  frequencies: Float32Array,
  floorDb: number,
  targetLevels: Float32Array,
) {
  if (frequencyData.length === 0 || nyquistHz <= 0) {
    targetLevels.fill(floorDb)
    return
  }

  for (let index = 0; index < frequencies.length; index += 1) {
    targetLevels[index] = interpolateFrequencyLevelDb(
      frequencyData,
      nyquistHz,
      frequencies[index],
      floorDb,
    )
  }
}

function createFftOverlayStore(frequencies: number[]): MutableFftOverlayStore {
  const frequenciesBuffer = Float32Array.from(frequencies)
  const preLevels = new Float32Array(frequenciesBuffer.length)
  const postLevels = new Float32Array(frequenciesBuffer.length)
  const listeners = new Set<FftStoreListener>()
  let snapshot: FftFrameSnapshot = {
    version: 0,
    hasData: false,
    sampleRate: 0,
    frequencies: frequenciesBuffer,
    preLevels,
    postLevels,
  }

  function notify() {
    listeners.forEach((listener) => listener())
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    publish: (sampleRate, buffers) => {
      const nyquistHz = sampleRate / 2
      fillSpectrumLevels(
        buffers.pre,
        nyquistHz,
        frequenciesBuffer,
        FFT_ANALYSER_MIN_DB,
        preLevels,
      )
      fillSpectrumLevels(
        buffers.post,
        nyquistHz,
        frequenciesBuffer,
        FFT_ANALYSER_MIN_DB,
        postLevels,
      )

      snapshot = {
        ...snapshot,
        version: snapshot.version + 1,
        hasData: true,
        sampleRate,
      }
      notify()
    },
    clear: () => {
      if (!snapshot.hasData && snapshot.version === 0) {
        return
      }

      preLevels.fill(FFT_ANALYSER_MIN_DB)
      postLevels.fill(FFT_ANALYSER_MIN_DB)
      snapshot = {
        ...snapshot,
        version: snapshot.version + 1,
        hasData: false,
        sampleRate: 0,
      }
      notify()
    },
  }
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

function setAudioParamValue(param: AudioParam, value: number) {
  param.value = value
}

function createDescriptorNode(context: AudioContext, descriptor: FilterDescriptor) {
  const filter = context.createBiquadFilter()
  filter.type = descriptor.type
  return filter
}

function applyDescriptorToNode(
  node: BiquadFilterNode,
  descriptor: FilterDescriptor,
) {
  node.type = descriptor.type
  setAudioParamValue(node.frequency, descriptor.frequencyHz)

  if (descriptor.gainDb !== undefined) {
    setAudioParamValue(node.gain, descriptor.gainDb)
  }

  if (descriptor.q !== undefined) {
    setAudioParamValue(node.Q, descriptor.q)
  }
}

function createBaselineDescriptors(baselineCurve: CurvePoint[]): FilterDescriptor[] {
  return GRAPH_EQ_CENTERS.map((center, index) => ({
    key: `baseline:${index}`,
    type:
      index === 0
        ? 'lowshelf'
        : index === GRAPH_EQ_CENTERS.length - 1
          ? 'highshelf'
          : 'peaking',
    frequencyHz: center,
    gainDb: sampleCurveGain(baselineCurve, center),
    q:
      index === 0 || index === GRAPH_EQ_CENTERS.length - 1
        ? undefined
        : GRAPH_EQ_Q,
  }))
}

function createBandDescriptors(band: EqBand): FilterDescriptor[] {
  const stageCount =
    band.type === 'lowCut' || band.type === 'highCut'
      ? band.slopeDbPerOct / 12
      : band.slopeDbPerOct / 6
  const stageGainDb = 'gainDb' in band ? band.gainDb / stageCount : undefined

  return Array.from({ length: stageCount }, (_, index) => {
    if (band.type === 'peaking') {
      return {
        key: `${band.id}:${index}`,
        type: 'peaking',
        frequencyHz: band.frequencyHz,
        gainDb: stageGainDb ?? band.gainDb,
        q: band.q,
      } satisfies FilterDescriptor
    }

    if (band.type === 'lowShelf' || band.type === 'highShelf') {
      return {
        key: `${band.id}:${index}`,
        type: band.type === 'lowShelf' ? 'lowshelf' : 'highshelf',
        frequencyHz: band.frequencyHz,
        gainDb: stageGainDb ?? band.gainDb,
      } satisfies FilterDescriptor
    }

    return {
      key: `${band.id}:${index}`,
      type: band.type === 'lowCut' ? 'highpass' : 'lowpass',
      frequencyHz: band.frequencyHz,
      q: CUT_Q,
    } satisfies FilterDescriptor
  })
}

function haveSameFilterStructure(
  currentDescriptors: FilterDescriptor[],
  nextDescriptors: FilterDescriptor[],
) {
  if (currentDescriptors.length !== nextDescriptors.length) {
    return false
  }

  return currentDescriptors.every((descriptor, index) => {
    const nextDescriptor = nextDescriptors[index]
    return Boolean(
      nextDescriptor &&
        descriptor.key === nextDescriptor.key &&
        descriptor.type === nextDescriptor.type,
    )
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
  fftSize = DEFAULT_FFT_SIZE,
) {
  const source = context.createMediaElementSource(audioElement)
  const dryGain = context.createGain()
  const wetInput = context.createGain()
  const preGainNode = context.createGain()
  const wetGain = context.createGain()
  const preAnalyser = context.createAnalyser()
  const postAnalyser = context.createAnalyser()

  configureAnalyser(preAnalyser, fftSize)
  configureAnalyser(postAnalyser, fftSize)

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
    filterDescriptors: [],
    isConfigured: false,
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
  fftSize: number,
) {
  const shouldApplyEq = !monitorBypassed
  const baselineDescriptors =
    shouldApplyEq && monitorBaselineEnabled
      ? createBaselineDescriptors(baselineCurve)
      : []
  const paramDescriptors = shouldApplyEq
    ? bands
        .filter((band) => !band.isBypassed)
        .flatMap((band) => createBandDescriptors(band))
    : []
  const filterDescriptors = [...baselineDescriptors, ...paramDescriptors]
  configureAnalyser(graph.preAnalyser, fftSize)
  configureAnalyser(graph.postAnalyser, fftSize)
  const structureChanged = !haveSameFilterStructure(
    graph.filterDescriptors,
    filterDescriptors,
  )

  if (structureChanged) {
    graph.filterNodes.forEach((node) => safeDisconnect(node))
    graph.filterNodes = filterDescriptors.map((descriptor) =>
      createDescriptorNode(context, descriptor),
    )
  }

  filterDescriptors.forEach((descriptor, index) => {
    const node = graph.filterNodes[index]
    if (!node) {
      return
    }

    applyDescriptorToNode(node, descriptor)
  })

  if (!graph.isConfigured || structureChanged) {
    safeDisconnect(graph.wetInput)
    safeDisconnect(graph.preGainNode)
    graph.wetInput.connect(graph.preGainNode)
    graph.preGainNode.connect(graph.preAnalyser)

    if (graph.filterNodes.length === 0) {
      graph.preGainNode.connect(graph.wetGain)
    } else {
      graph.preGainNode.connect(graph.filterNodes[0])

      graph.filterNodes.forEach((node, index) => {
        const nextNode = graph.filterNodes[index + 1] ?? graph.wetGain
        node.connect(nextNode)
      })
    }
  }

  setAudioParamValue(graph.preGainNode.gain, dbToLinear(preGainDb))
  setAudioParamValue(graph.dryGain.gain, 0)
  setAudioParamValue(graph.wetGain.gain, 1)
  graph.filterDescriptors = filterDescriptors
  graph.isConfigured = true
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
  graph.isConfigured = false
}

export function mapFrequencyDataToSpectrum(
  frequencyData: Float32Array,
  nyquistHz: number,
  frequencies = FFT_OVERLAY_FREQUENCIES,
  floorDb = FFT_ANALYSER_MIN_DB,
): SpectrumPoint[] {
  const frequencyBuffer = Float32Array.from(frequencies)
  const levels = new Float32Array(frequencyBuffer.length)
  fillSpectrumLevels(
    frequencyData,
    nyquistHz,
    frequencyBuffer,
    floorDb,
    levels,
  )
  return frequencies.map((frequencyHz, index) => ({
    frequencyHz,
    levelDb: levels[index],
  }))
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

export function useEqPlaybackMonitor({
  audioElement,
  bands,
  baselineCurve,
  monitorBypassed,
  monitorBaselineEnabled,
  preGainDb,
  fftSize = DEFAULT_FFT_SIZE,
}: {
  audioElement: HTMLAudioElement | null
  bands: EqBand[]
  baselineCurve: CurvePoint[]
  monitorBypassed: boolean
  monitorBaselineEnabled: boolean
  preGainDb: number
  fftSize?: number
}) {
  const audioContextRef = useRef<AudioContext | null>(null)
  const graphRef = useRef<MonitorGraph | null>(null)
  const attachedElementRef = useRef<HTMLAudioElement | null>(null)
  const spectrumBuffersRef = useRef<SpectrumBuffers | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const isSamplingRef = useRef(false)
  const isDisposedRef = useRef(false)
  const hasFftFrameRef = useRef(false)
  const sampleFftOverlayRef = useRef<() => void>(() => undefined)
  const fftStoreRef = useRef<MutableFftOverlayStore | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [hasFftFrame, setHasFftFrame] = useState(false)

  if (!fftStoreRef.current) {
    fftStoreRef.current = createFftOverlayStore(FFT_OVERLAY_FREQUENCIES)
  }

  const stopFftOverlay = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }

    isSamplingRef.current = false
    fftStoreRef.current?.clear()
    if (hasFftFrameRef.current) {
      hasFftFrameRef.current = false
      setHasFftFrame(false)
    }
  }, [])

  sampleFftOverlayRef.current = () => {
    if (isDisposedRef.current) {
      return
    }

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
      stopFftOverlay()
      return
    }

    spectrumBuffersRef.current = ensureSpectrumBuffers(
      spectrumBuffersRef.current,
      graph,
    )

    graph.preAnalyser.getFloatFrequencyData(
      spectrumBuffersRef.current.pre as Float32Array<ArrayBuffer>,
    )
    graph.postAnalyser.getFloatFrequencyData(
      spectrumBuffersRef.current.post as Float32Array<ArrayBuffer>,
    )
    fftStoreRef.current?.publish(context.sampleRate, spectrumBuffersRef.current)

    if (!hasFftFrameRef.current) {
      hasFftFrameRef.current = true
      setHasFftFrame(true)
    }

    animationFrameRef.current = requestAnimationFrame(sampleFftOverlayRef.current)
  }

  const startFftOverlay = useCallback(() => {
    if (isDisposedRef.current) {
      return
    }

    const context = audioContextRef.current
    const graph = graphRef.current
    const attachedElement = attachedElementRef.current

    if (!context || !graph || !attachedElement || attachedElement.paused) {
      return
    }

    if (context.state === 'suspended') {
      void context.resume()
    }

    if (isSamplingRef.current) {
      return
    }

    isSamplingRef.current = true
    sampleFftOverlayRef.current()
  }, [])

  useEffect(() => {
    if (!audioElement) {
      return
    }

    if (attachedElementRef.current === audioElement && graphRef.current) {
      return
    }

    const ContextConstructor = getAudioContextConstructor()
    if (!ContextConstructor) {
      setErrorMessage('This browser cannot monitor audio through Web Audio.')
      return
    }

    try {
      stopFftOverlay()

      if (graphRef.current && attachedElementRef.current) {
        disconnectMonitorGraph(graphRef.current)
      }

      const context = audioContextRef.current ?? new ContextConstructor()
      const graph = createMonitorGraph(context, audioElement, fftSize)

      audioContextRef.current = context
      graphRef.current = graph
      attachedElementRef.current = audioElement
      spectrumBuffersRef.current = null
      setErrorMessage(null)
      syncMonitorGraph(
        context,
        graph,
        bands,
        baselineCurve,
        monitorBypassed,
        monitorBaselineEnabled,
        preGainDb,
        fftSize,
      )

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
  }, [audioElement, stopFftOverlay])

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
      fftSize,
    )
    setErrorMessage(null)
  }, [bands, baselineCurve, monitorBaselineEnabled, monitorBypassed, preGainDb, fftSize])

  useEffect(() => {
    isDisposedRef.current = false

    if (!audioElement) {
      stopFftOverlay()
      return
    }

    const handlePlay = () => {
      startFftOverlay()
    }
    const handleStop = () => {
      stopFftOverlay()
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
      stopFftOverlay()
    }
  }, [audioElement, startFftOverlay, stopFftOverlay])

  useEffect(() => {
    isDisposedRef.current = false

    return () => {
      isDisposedRef.current = true
      stopFftOverlay()

      const graph = graphRef.current
      if (graph) {
        disconnectMonitorGraph(graph)
      }

      if (audioContextRef.current) {
        void audioContextRef.current.close()
      }
    }
  }, [stopFftOverlay])

  return {
    errorMessage,
    fftStore: fftStoreRef.current as FftOverlayStore,
    hasFftFrame,
  }
}
