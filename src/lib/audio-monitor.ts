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
export const AUDIO_PARAM_RAMP_MS = 40
const AUDIO_PARAM_RAMP_SECONDS = AUDIO_PARAM_RAMP_MS / 1000
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
type SchedulableAudioParam = {
  value: number
  cancelScheduledValues?: (time: number) => void
  setValueAtTime?: (value: number, time: number) => void
  linearRampToValueAtTime?: (value: number, time: number) => void
}

type BandStageGroup = {
  bandId: string
  type: EqBand['type']
  nodes: BiquadFilterNode[]
}

type MonitorGraph = {
  source: MediaElementAudioSourceNode
  dryGain: GainNode
  wetInput: GainNode
  preGainNode: GainNode
  wetGain: GainNode
  preAnalyser: AnalyserNode
  postAnalyser: AnalyserNode
  baselineNodes: BiquadFilterNode[]
  paramStages: BandStageGroup[]
  filterNodes: BiquadFilterNode[]
  structureKey: string | null
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

async function closeAudioContextSafely(context: AudioContext | null) {
  if (!context || context.state === 'closed') {
    return
  }

  try {
    await context.close()
  } catch {
    // Ignore redundant close calls from browser lifecycle cleanup.
  }
}

function dbToLinear(db: number) {
  return 10 ** (db / 20)
}

function getMonitorActiveBands(bands: EqBand[]) {
  return bands.filter((band) => !band.isBypassed)
}

function getStageCount(band: EqBand) {
  if (band.type === 'lowCut' || band.type === 'highCut') {
    return band.slopeDbPerOct / 12
  }

  return band.slopeDbPerOct / 6
}

function scheduleAudioParamValue(
  context: AudioContext,
  param: SchedulableAudioParam,
  nextValue: number,
  rampSeconds: number,
) {
  const now = context.currentTime

  if (
    rampSeconds > 0 &&
    typeof param.cancelScheduledValues === 'function' &&
    typeof param.setValueAtTime === 'function' &&
    typeof param.linearRampToValueAtTime === 'function'
  ) {
    param.cancelScheduledValues(now)
    param.setValueAtTime(param.value, now)
    param.linearRampToValueAtTime(nextValue, now + rampSeconds)
    return
  }

  if (typeof param.cancelScheduledValues === 'function') {
    param.cancelScheduledValues(now)
  }

  if (typeof param.setValueAtTime === 'function') {
    param.setValueAtTime(nextValue, now)
    return
  }

  param.value = nextValue
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

function createFilterNodesForBand(context: AudioContext, band: EqBand) {
  const stageCount = getStageCount(band)
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

function getMonitorStructureKey(
  bands: EqBand[],
  monitorBypassed: boolean,
  monitorBaselineEnabled: boolean,
) {
  if (monitorBypassed) {
    return 'bypassed'
  }

  const bandKey = getMonitorActiveBands(bands)
    .map((band) => `${band.id}:${band.type}:${band.slopeDbPerOct}`)
    .join('|')

  return `${monitorBaselineEnabled ? 'baseline' : 'flat'}::${bandKey}`
}

function applyBaselineCurveToNodes(
  context: AudioContext,
  baselineNodes: BiquadFilterNode[],
  baselineCurve: CurvePoint[],
) {
  if (baselineNodes.length !== GRAPH_EQ_CENTERS.length) {
    return false
  }

  baselineNodes.forEach((node, index) => {
    scheduleAudioParamValue(
      context,
      node.gain,
      sampleCurveGain(baselineCurve, GRAPH_EQ_CENTERS[index]),
      AUDIO_PARAM_RAMP_SECONDS,
    )
  })

  return true
}

function applyBandStageParameters(
  context: AudioContext,
  stage: BandStageGroup,
  band: EqBand,
) {
  const expectedStageCount = getStageCount(band)
  if (stage.nodes.length !== expectedStageCount || stage.type !== band.type) {
    return false
  }

  const stageGainDb = 'gainDb' in band ? band.gainDb / expectedStageCount : undefined

  stage.nodes.forEach((node) => {
    scheduleAudioParamValue(
      context,
      node.frequency,
      band.frequencyHz,
      AUDIO_PARAM_RAMP_SECONDS,
    )

    if (band.type === 'peaking') {
      scheduleAudioParamValue(
        context,
        node.gain,
        stageGainDb ?? band.gainDb,
        AUDIO_PARAM_RAMP_SECONDS,
      )
      scheduleAudioParamValue(context, node.Q, band.q, AUDIO_PARAM_RAMP_SECONDS)
      return
    }

    if (band.type === 'lowShelf' || band.type === 'highShelf') {
      scheduleAudioParamValue(
        context,
        node.gain,
        stageGainDb ?? band.gainDb,
        AUDIO_PARAM_RAMP_SECONDS,
      )
      return
    }

    scheduleAudioParamValue(context, node.Q, CUT_Q, AUDIO_PARAM_RAMP_SECONDS)
  })

  return true
}

function applyMonitorGraphParameters(
  context: AudioContext,
  graph: MonitorGraph,
  bands: EqBand[],
  baselineCurve: CurvePoint[],
  monitorBypassed: boolean,
  monitorBaselineEnabled: boolean,
  preGainDb: number,
) {
  if (
    graph.structureKey !==
    getMonitorStructureKey(bands, monitorBypassed, monitorBaselineEnabled)
  ) {
    return false
  }

  scheduleAudioParamValue(
    context,
    graph.preGainNode.gain,
    dbToLinear(preGainDb),
    AUDIO_PARAM_RAMP_SECONDS,
  )

  if (monitorBypassed) {
    return graph.filterNodes.length === 0
  }

  if (monitorBaselineEnabled) {
    if (!applyBaselineCurveToNodes(context, graph.baselineNodes, baselineCurve)) {
      return false
    }
  } else if (graph.baselineNodes.length > 0) {
    return false
  }

  const activeBands = getMonitorActiveBands(bands)
  if (graph.paramStages.length !== activeBands.length) {
    return false
  }

  for (let index = 0; index < activeBands.length; index += 1) {
    const stage = graph.paramStages[index]
    const band = activeBands[index]

    if (!stage || stage.bandId !== band.id) {
      return false
    }

    if (!applyBandStageParameters(context, stage, band)) {
      return false
    }
  }

  return true
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
    baselineNodes: [],
    paramStages: [],
    filterNodes: [],
    structureKey: null,
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
  if (
    applyMonitorGraphParameters(
      context,
      graph,
      bands,
      baselineCurve,
      monitorBypassed,
      monitorBaselineEnabled,
      preGainDb,
    )
  ) {
    graph.dryGain.gain.value = 0
    graph.wetGain.gain.value = 1
    return
  }

  const shouldApplyEq = !monitorBypassed
  const baselineNodes =
    shouldApplyEq && monitorBaselineEnabled
      ? createGraphEqNodes(context, baselineCurve)
      : []
  const paramStages = shouldApplyEq
    ? getMonitorActiveBands(bands).map((band) => ({
        bandId: band.id,
        type: band.type,
        nodes: createFilterNodesForBand(context, band),
      }))
    : []
  const paramNodes = paramStages.flatMap((stage) => stage.nodes)
  const filterNodes = [...baselineNodes, ...paramNodes]

  safeDisconnect(graph.wetInput)
  safeDisconnect(graph.preGainNode)
  graph.filterNodes.forEach((node) => safeDisconnect(node))

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
  graph.baselineNodes = baselineNodes
  graph.paramStages = paramStages
  graph.filterNodes = filterNodes
  graph.structureKey = getMonitorStructureKey(
    bands,
    monitorBypassed,
    monitorBaselineEnabled,
  )
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
  graph.baselineNodes = []
  graph.paramStages = []
  graph.filterNodes = []
  graph.structureKey = null
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

  const disposeMonitorResources = useEffectEvent(() => {
    clearFftOverlay()

    const graph = graphRef.current
    const context = audioContextRef.current

    graphRef.current = null
    audioContextRef.current = null
    attachedElementRef.current = null
    spectrumBuffersRef.current = null

    if (graph) {
      disconnectMonitorGraph(graph)
    }

    void closeAudioContextSafely(context)
  })

  const sampleFftOverlay = useEffectEvent(() => {
    const context = audioContextRef.current
    const graph = graphRef.current
    const attachedElement = attachedElementRef.current

    if (
      !context ||
      context.state === 'closed' ||
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

    if (
      !context ||
      context.state === 'closed' ||
      !attachedElement ||
      attachedElement.paused
    ) {
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
      const context = new ContextConstructor()
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
        disposeMonitorResources()
      }
    } catch (error) {
      disposeMonitorResources()
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to initialize the monitor audio graph.'
      setErrorMessage(message)
    }
  }, [audioElement, disposeMonitorResources])

  useEffect(() => {
    const context = audioContextRef.current
    const graph = graphRef.current

    if (!context || context.state === 'closed' || !graph) {
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
      disposeMonitorResources()
    }
  }, [disposeMonitorResources])

  return {
    errorMessage,
    fftOverlay,
  }
}
