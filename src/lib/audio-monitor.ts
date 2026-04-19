import {
  startTransition,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react'
import { createLogFrequencyGrid } from './curve'
import {
  designBandTopology,
  type DesignedSection,
} from './filter-coefficients'
import type { CurvePoint, EqBand, FftOverlay, SpectrumPoint } from '../types'

const GRAPH_EQ_Q = 4.318
export const FFT_ANALYSER_MIN_DB = -96
export const FFT_ANALYSER_MAX_DB = 0
const FFT_ANALYSER_SIZE = 8192
const FFT_ANALYSER_SMOOTHING = 0.82
export const FFT_DISPLAY_GRID_SIZE = 512
const PARAM_LANE_CROSSFADE_MS = 5
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

type MonitorGraph = {
  source: MediaElementAudioSourceNode
  dryGain: GainNode
  wetInput: GainNode
  preGainNode: GainNode
  paramBus: GainNode
  wetGain: GainNode
  preAnalyser: AnalyserNode
  postAnalyser: AnalyserNode
  baselineNodes: BiquadFilterNode[]
  baselineDescriptors: FilterDescriptor[]
  activeParamLane: ParamLane | null
  stagingParamLane: ParamLane | null
  laneSwapTimerId: number | null
  isConfigured: boolean
}

type ParamLane = {
  input: GainNode
  mixGain: GainNode
  filterNodes: IIRFilterNode[]
  sectionKeys: string[]
}

type FilterDescriptor = {
  key: string
  type: BiquadFilterType
  frequencyHz: number
  gainDb?: number
  q?: number
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

function scheduleAudioParamValue(
  param: AudioParam,
  targetValue: number,
  startTime: number,
  durationSeconds: number,
) {
  param.cancelScheduledValues(startTime)
  param.setValueAtTime(param.value, startTime)
  param.linearRampToValueAtTime(targetValue, startTime + durationSeconds)
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

function createParamLane(
  context: AudioContext,
  sections: DesignedSection[],
) {
  const input = context.createGain()
  const mixGain = context.createGain()
  const filterNodes = sections.map(({ section }) =>
    context.createIIRFilter(
      Array.from(section.feedforward),
      Array.from(section.feedback),
    ),
  )

  if (filterNodes.length === 0) {
    input.connect(mixGain)
  } else {
    input.connect(filterNodes[0])
    filterNodes.forEach((node, index) => {
      const nextNode = filterNodes[index + 1] ?? mixGain
      node.connect(nextNode)
    })
  }

  return {
    input,
    mixGain,
    filterNodes,
    sectionKeys: sections.map(({ key }) => key),
  } satisfies ParamLane
}

function disconnectParamLane(lane: ParamLane) {
  safeDisconnect(lane.input)
  safeDisconnect(lane.mixGain)
  lane.filterNodes.forEach((node) => safeDisconnect(node))
}

function haveSameSectionKeys(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false
  }

  return left.every((key, index) => key === right[index])
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

function createBandSections(
  band: EqBand,
  sampleRate: number,
): DesignedSection[] {
  return designBandTopology(band, sampleRate)
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
): MonitorGraph {
  const source = context.createMediaElementSource(audioElement)
  const dryGain = context.createGain()
  const wetInput = context.createGain()
  const preGainNode = context.createGain()
  const paramBus = context.createGain()
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
    paramBus,
    wetGain,
    preAnalyser,
    postAnalyser,
    baselineNodes: [],
    baselineDescriptors: [],
    activeParamLane: null,
    stagingParamLane: null,
    laneSwapTimerId: null,
    isConfigured: false,
  }
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
      ? createBaselineDescriptors(baselineCurve)
      : []
  const paramSections = shouldApplyEq
    ? bands
        .filter((band) => !band.isBypassed)
        .flatMap((band) => createBandSections(band, context.sampleRate))
    : []
  const baselineStructureChanged = !haveSameFilterStructure(
    graph.baselineDescriptors,
    baselineDescriptors,
  )
  const nextSectionKeys = paramSections.map(({ key }) => key)
  const activeSectionKeys = graph.activeParamLane?.sectionKeys ?? []

  if (baselineStructureChanged) {
    graph.baselineNodes.forEach((node) => safeDisconnect(node))
    graph.baselineNodes = baselineDescriptors.map((descriptor) =>
      createDescriptorNode(context, descriptor),
    )
  }

  baselineDescriptors.forEach((descriptor, index) => {
    const node = graph.baselineNodes[index]
    if (!node) {
      return
    }

    applyDescriptorToNode(node, descriptor)
  })

  setAudioParamValue(graph.preGainNode.gain, dbToLinear(preGainDb))
  setAudioParamValue(graph.dryGain.gain, 0)
  setAudioParamValue(graph.wetGain.gain, 1)
  graph.baselineDescriptors = baselineDescriptors

  const nextLane = createParamLane(context, paramSections)

  if (graph.laneSwapTimerId !== null) {
    window.clearTimeout(graph.laneSwapTimerId)
    graph.laneSwapTimerId = null
    if (graph.activeParamLane) {
      setAudioParamValue(graph.activeParamLane.mixGain.gain, 1)
    }
  }

  if (graph.stagingParamLane) {
    disconnectParamLane(graph.stagingParamLane)
    graph.stagingParamLane = null
  }

  const now = context.currentTime
  const crossfadeSeconds = PARAM_LANE_CROSSFADE_MS / 1000

  if (!graph.activeParamLane) {
    graph.activeParamLane = nextLane
    setAudioParamValue(graph.activeParamLane.mixGain.gain, 1)
  } else if (haveSameSectionKeys(activeSectionKeys, nextSectionKeys)) {
    disconnectParamLane(graph.activeParamLane)
    graph.activeParamLane = nextLane
    setAudioParamValue(graph.activeParamLane.mixGain.gain, 1)
  } else {
    graph.stagingParamLane = nextLane
    setAudioParamValue(graph.stagingParamLane.mixGain.gain, 0)
    scheduleAudioParamValue(
      graph.activeParamLane.mixGain.gain,
      0,
      now,
      crossfadeSeconds,
    )
    scheduleAudioParamValue(
      graph.stagingParamLane.mixGain.gain,
      1,
      now,
      crossfadeSeconds,
    )

    graph.laneSwapTimerId = window.setTimeout(() => {
      if (!graph.stagingParamLane) {
        return
      }

      const previousActiveLane = graph.activeParamLane
      graph.activeParamLane = graph.stagingParamLane
      graph.stagingParamLane = null

      if (previousActiveLane) {
        disconnectParamLane(previousActiveLane)
      }

      safeDisconnect(graph.paramBus)
      graph.paramBus.connect(graph.activeParamLane.input)
      graph.laneSwapTimerId = null
    }, PARAM_LANE_CROSSFADE_MS + 1)
  }

  safeDisconnect(graph.wetInput)
  safeDisconnect(graph.preGainNode)
  safeDisconnect(graph.paramBus)
  graph.baselineNodes.forEach((node) => safeDisconnect(node))

  graph.wetInput.connect(graph.preGainNode)
  graph.preGainNode.connect(graph.preAnalyser)

  let currentOutput: AudioNode = graph.preGainNode
  if (graph.baselineNodes.length > 0) {
    currentOutput.connect(graph.baselineNodes[0])
    graph.baselineNodes.forEach((node, index) => {
      const nextNode = graph.baselineNodes[index + 1]
      if (nextNode) {
        node.connect(nextNode)
      }
    })
    currentOutput = graph.baselineNodes[graph.baselineNodes.length - 1]
  }

  currentOutput.connect(graph.paramBus)

  if (graph.activeParamLane) {
    graph.paramBus.connect(graph.activeParamLane.input)
    safeDisconnect(graph.activeParamLane.mixGain)
    graph.activeParamLane.mixGain.connect(graph.wetGain)
  }

  if (graph.stagingParamLane) {
    graph.paramBus.connect(graph.stagingParamLane.input)
    safeDisconnect(graph.stagingParamLane.mixGain)
    graph.stagingParamLane.mixGain.connect(graph.wetGain)
  }

  graph.isConfigured = true
}

export function disconnectMonitorGraph(graph: MonitorGraph) {
  if (graph.laneSwapTimerId !== null) {
    window.clearTimeout(graph.laneSwapTimerId)
    graph.laneSwapTimerId = null
  }
  safeDisconnect(graph.source)
  safeDisconnect(graph.dryGain)
  safeDisconnect(graph.wetInput)
  safeDisconnect(graph.preGainNode)
  safeDisconnect(graph.paramBus)
  safeDisconnect(graph.wetGain)
  safeDisconnect(graph.preAnalyser)
  safeDisconnect(graph.postAnalyser)
  graph.baselineNodes.forEach((node) => safeDisconnect(node))
  if (graph.activeParamLane) {
    disconnectParamLane(graph.activeParamLane)
    graph.activeParamLane = null
  }
  if (graph.stagingParamLane) {
    disconnectParamLane(graph.stagingParamLane)
    graph.stagingParamLane = null
  }
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
  }, [audioElement])

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
