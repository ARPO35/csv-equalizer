import {
  startTransition,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react'
import { createLogFrequencyGrid } from './curve'
import {
  DEFAULT_FILTER_Q,
  designBandSections,
  type FilterSection,
} from './filter-coefficients'
import type { CurvePoint, EqBand, FftOverlay, SpectrumPoint } from '../types'

const GRAPH_EQ_Q = 4.318
export const FFT_ANALYSER_MIN_DB = -96
export const FFT_ANALYSER_MAX_DB = 0
const FFT_ANALYSER_SIZE = 8192
const FFT_ANALYSER_SMOOTHING = 0.82
export const FFT_DISPLAY_GRID_SIZE = 512
const MONITOR_CROSSFADE_MS = 10
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
const FFT_OVERLAY_FREQUENCIES = createLogFrequencyGrid(FFT_DISPLAY_GRID_SIZE)

type AudioContextConstructor = new () => AudioContext

type SectionDescriptor = FilterSection & {
  key: string
}

type MonitorLane = {
  input: GainNode
  output: GainNode
  filterNodes: IIRFilterNode[]
  descriptors: SectionDescriptor[]
}

type MonitorGraph = {
  source: MediaElementAudioSourceNode
  dryGain: GainNode
  wetInput: GainNode
  preGainNode: GainNode
  wetGain: GainNode
  preAnalyser: AnalyserNode
  postAnalyser: AnalyserNode
  activeLane: MonitorLane
  stagingLane: MonitorLane
  filterNodes: IIRFilterNode[]
  filterDescriptors: SectionDescriptor[]
  isConfigured: boolean
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

function scheduleGainTransition(
  param: AudioParam,
  value: number,
  context: AudioContext,
  durationMs = 0,
) {
  const now = context.currentTime

  const cancellableParam = param as AudioParam & {
    cancelScheduledValues?: (cancelTime: number) => AudioParam
    setValueAtTime?: (value: number, startTime: number) => AudioParam
    linearRampToValueAtTime?: (value: number, endTime: number) => AudioParam
  }

  cancellableParam.cancelScheduledValues?.(now)

  if (cancellableParam.setValueAtTime) {
    cancellableParam.setValueAtTime(param.value, now)
  } else {
    param.value = value
    return
  }

  if (durationMs > 0 && cancellableParam.linearRampToValueAtTime) {
    cancellableParam.linearRampToValueAtTime(value, now + durationMs / 1000)
  } else {
    cancellableParam.setValueAtTime(value, now)
  }

  param.value = value
}

function createLane(context: AudioContext): MonitorLane {
  return {
    input: context.createGain(),
    output: context.createGain(),
    filterNodes: [],
    descriptors: [],
  } satisfies MonitorLane
}

function disconnectLane(lane: MonitorLane) {
  safeDisconnect(lane.input)
  lane.filterNodes.forEach((node) => safeDisconnect(node))
  safeDisconnect(lane.output)
}

function wireLane(lane: MonitorLane) {
  safeDisconnect(lane.input)
  lane.filterNodes.forEach((node) => safeDisconnect(node))

  if (lane.filterNodes.length === 0) {
    lane.input.connect(lane.output)
    return
  }

  lane.input.connect(lane.filterNodes[0])

  lane.filterNodes.forEach((node, index) => {
    const nextNode = lane.filterNodes[index + 1] ?? lane.output
    node.connect(nextNode)
  })
}

function createSectionNode(
  context: AudioContext,
  descriptor: SectionDescriptor,
) {
  return context.createIIRFilter(descriptor.feedforward, descriptor.feedback)
}

function createBaselineDescriptors(
  baselineCurve: CurvePoint[],
  sampleRate: number,
): SectionDescriptor[] {
  return GRAPH_EQ_CENTERS.flatMap((center, index) => {
    const band: EqBand =
      index === 0
        ? {
            id: `baseline:${index}`,
            type: 'lowShelf',
            frequencyHz: center,
            gainDb: sampleCurveGain(baselineCurve, center),
            q: DEFAULT_FILTER_Q,
            slopeDbPerOct: 6,
            isBypassed: false,
          }
        : index === GRAPH_EQ_CENTERS.length - 1
          ? {
              id: `baseline:${index}`,
              type: 'highShelf',
              frequencyHz: center,
              gainDb: sampleCurveGain(baselineCurve, center),
              q: DEFAULT_FILTER_Q,
              slopeDbPerOct: 6,
              isBypassed: false,
            }
          : {
              id: `baseline:${index}`,
              type: 'peaking',
              frequencyHz: center,
              gainDb: sampleCurveGain(baselineCurve, center),
              q: GRAPH_EQ_Q,
              slopeDbPerOct: 12,
              isBypassed: false,
            }

    return designBandSections(band, sampleRate).map((section, sectionIndex) => ({
      key: `${band.id}:${sectionIndex}`,
      ...section,
    }))
  })
}

function createBandDescriptors(
  band: EqBand,
  sampleRate: number,
): SectionDescriptor[] {
  return designBandSections(band, sampleRate).map((section, index) => ({
    key: `${band.id}:${index}`,
    ...section,
  }))
}

function haveSameSectionStructure(
  currentDescriptors: SectionDescriptor[],
  nextDescriptors: SectionDescriptor[],
) {
  if (currentDescriptors.length !== nextDescriptors.length) {
    return false
  }

  return currentDescriptors.every((descriptor, index) => {
    const nextDescriptor = nextDescriptors[index]
    return Boolean(nextDescriptor && descriptor.key === nextDescriptor.key)
  })
}

function haveSameSectionDescriptors(
  currentDescriptors: SectionDescriptor[],
  nextDescriptors: SectionDescriptor[],
) {
  if (!haveSameSectionStructure(currentDescriptors, nextDescriptors)) {
    return false
  }

  return currentDescriptors.every((descriptor, index) => {
    const nextDescriptor = nextDescriptors[index]

    return (
      descriptor.feedforward.every(
        (value, coefficientIndex) =>
          value === nextDescriptor.feedforward[coefficientIndex],
      ) &&
      descriptor.feedback.every(
        (value, coefficientIndex) =>
          value === nextDescriptor.feedback[coefficientIndex],
      )
    )
  })
}

function rebuildLane(
  context: AudioContext,
  lane: MonitorLane,
  descriptors: SectionDescriptor[],
) {
  disconnectLane(lane)
  lane.filterNodes = descriptors.map((descriptor) =>
    createSectionNode(context, descriptor),
  )
  lane.descriptors = descriptors
  wireLane(lane)
}

export function createMonitorGraph(
  context: AudioContext,
  audioElement: HTMLAudioElement,
): MonitorGraph {
  const source = context.createMediaElementSource(audioElement)
  const dryGain = context.createGain()
  const wetInput = context.createGain()
  const preGainNode = context.createGain()
  const wetGain = context.createGain()
  const preAnalyser = context.createAnalyser()
  const postAnalyser = context.createAnalyser()
  const activeLane = createLane(context)
  const stagingLane = createLane(context)

  configureAnalyser(preAnalyser)
  configureAnalyser(postAnalyser)

  source.connect(dryGain)
  dryGain.connect(context.destination)
  source.connect(wetInput)
  wetInput.connect(preGainNode)
  preGainNode.connect(preAnalyser)
  preGainNode.connect(activeLane.input)
  preGainNode.connect(stagingLane.input)
  activeLane.output.connect(wetGain)
  stagingLane.output.connect(wetGain)
  wetGain.connect(context.destination)
  wetGain.connect(postAnalyser)
  setAudioParamValue(activeLane.output.gain, 1)
  setAudioParamValue(stagingLane.output.gain, 0)

  return {
    source,
    dryGain,
    wetInput,
    preGainNode,
    wetGain,
    preAnalyser,
    postAnalyser,
    activeLane,
    stagingLane,
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
) {
  const shouldApplyEq = !monitorBypassed
  const baselineDescriptors =
    shouldApplyEq && monitorBaselineEnabled
      ? createBaselineDescriptors(baselineCurve, context.sampleRate)
      : []
  const paramDescriptors = shouldApplyEq
    ? bands
        .filter((band) => !band.isBypassed)
        .flatMap((band) => createBandDescriptors(band, context.sampleRate))
    : []
  const nextDescriptors = [...baselineDescriptors, ...paramDescriptors]
  const descriptorsChanged = !haveSameSectionDescriptors(
    graph.filterDescriptors,
    nextDescriptors,
  )

  if (!graph.isConfigured) {
    rebuildLane(context, graph.activeLane, nextDescriptors)
    setAudioParamValue(graph.activeLane.output.gain, 1)
    setAudioParamValue(graph.stagingLane.output.gain, 0)
    graph.filterDescriptors = nextDescriptors
    graph.filterNodes = graph.activeLane.filterNodes
    graph.isConfigured = true
  } else if (descriptorsChanged) {
    rebuildLane(context, graph.stagingLane, nextDescriptors)
    scheduleGainTransition(
      graph.activeLane.output.gain,
      0,
      context,
      MONITOR_CROSSFADE_MS,
    )
    scheduleGainTransition(
      graph.stagingLane.output.gain,
      1,
      context,
      MONITOR_CROSSFADE_MS,
    )

    const previousActiveLane = graph.activeLane
    graph.activeLane = graph.stagingLane
    graph.stagingLane = previousActiveLane
    graph.filterDescriptors = nextDescriptors
    graph.filterNodes = graph.activeLane.filterNodes
  }

  setAudioParamValue(graph.preGainNode.gain, dbToLinear(preGainDb))
  setAudioParamValue(graph.dryGain.gain, 0)
  setAudioParamValue(graph.wetGain.gain, 1)
}

export function disconnectMonitorGraph(graph: MonitorGraph) {
  safeDisconnect(graph.source)
  safeDisconnect(graph.dryGain)
  safeDisconnect(graph.wetInput)
  safeDisconnect(graph.preGainNode)
  safeDisconnect(graph.wetGain)
  safeDisconnect(graph.preAnalyser)
  safeDisconnect(graph.postAnalyser)
  disconnectLane(graph.activeLane)
  disconnectLane(graph.stagingLane)
  graph.filterNodes = []
  graph.filterDescriptors = []
  graph.isConfigured = false
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

  return createRawSpectrumTrace(
    frequencyData,
    nyquistHz,
    frequencies,
    floorDb,
  )
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
      syncMonitorGraph(
        context,
        graph,
        bands,
        baselineCurve,
        monitorBypassed,
        monitorBaselineEnabled,
        preGainDb,
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
