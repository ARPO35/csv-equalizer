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
const FFT_OVERLAY_SAMPLE_INTERVAL_MS = 1000 / 30
export const MONITOR_UPDATE_INTERVAL_MS = 150
export const AUDIO_PARAM_RAMP_MS = 40
export const GRAPH_CROSSFADE_MS = 60
const AUDIO_PARAM_RAMP_SECONDS = AUDIO_PARAM_RAMP_MS / 1000
const GRAPH_CROSSFADE_SECONDS = GRAPH_CROSSFADE_MS / 1000
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
type MonitorBranchKey = 'a' | 'b'

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

type MonitorBranch = {
  entry: GainNode
  output: GainNode
  baselineNodes: BiquadFilterNode[]
  paramStages: BandStageGroup[]
  filterNodes: BiquadFilterNode[]
  structureKey: string | null
}

type MonitorGraph = {
  source: MediaElementAudioSourceNode
  dryGain: GainNode
  wetInput: GainNode
  preGainNode: GainNode
  wetGain: GainNode
  preAnalyser: AnalyserNode
  postAnalyser: AnalyserNode
  branchA: MonitorBranch
  branchB: MonitorBranch
  activeBranchKey: MonitorBranchKey
  filterNodes: BiquadFilterNode[]
  cleanupTimerId: ReturnType<typeof globalThis.setTimeout> | null
}

type MonitorStateSnapshot = {
  bands: EqBand[]
  baselineCurve: CurvePoint[]
  monitorBypassed: boolean
  monitorBaselineEnabled: boolean
  preGainDb: number
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

function getMonitorActiveBands(bands: EqBand[]) {
  return bands.filter((band) => !band.isBypassed)
}

function getStageCount(band: EqBand) {
  if (band.type === 'lowCut' || band.type === 'highCut') {
    return band.slopeDbPerOct / 12
  }

  return band.slopeDbPerOct / 6
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

function createMonitorBranch(context: AudioContext): MonitorBranch {
  const entry = context.createGain()
  const output = context.createGain()
  output.gain.value = 0

  return {
    entry,
    output,
    baselineNodes: [],
    paramStages: [],
    filterNodes: [],
    structureKey: null,
  }
}

function getActiveBranch(graph: MonitorGraph) {
  return graph.activeBranchKey === 'a' ? graph.branchA : graph.branchB
}

function getInactiveBranch(graph: MonitorGraph) {
  return graph.activeBranchKey === 'a' ? graph.branchB : graph.branchA
}

function clearBranchCleanup(graph: MonitorGraph) {
  if (graph.cleanupTimerId !== null) {
    globalThis.clearTimeout(graph.cleanupTimerId)
    graph.cleanupTimerId = null
  }
}

function resetMonitorBranch(branch: MonitorBranch) {
  safeDisconnect(branch.entry)
  branch.filterNodes.forEach((node) => safeDisconnect(node))
  branch.baselineNodes = []
  branch.paramStages = []
  branch.filterNodes = []
  branch.structureKey = null
}

function connectMonitorBranch(branch: MonitorBranch) {
  safeDisconnect(branch.entry)
  branch.filterNodes.forEach((node) => safeDisconnect(node))

  if (branch.filterNodes.length === 0) {
    branch.entry.connect(branch.output)
    return
  }

  branch.entry.connect(branch.filterNodes[0])

  branch.filterNodes.forEach((node, index) => {
    const nextNode = branch.filterNodes[index + 1] ?? branch.output
    node.connect(nextNode)
  })
}

function getMonitorStructureKey(state: MonitorStateSnapshot) {
  if (state.monitorBypassed) {
    return 'bypassed'
  }

  const bandKey = getMonitorActiveBands(state.bands)
    .map((band) => `${band.id}:${band.type}:${band.slopeDbPerOct}`)
    .join('|')

  return `${state.monitorBaselineEnabled ? 'baseline' : 'flat'}::${bandKey}`
}

function scheduleAudioParamValue(
  context: AudioContext,
  param: SchedulableAudioParam,
  nextValue: number,
  rampSeconds: number,
) {
  const now = 'currentTime' in context ? context.currentTime : 0

  if (rampSeconds <= 0) {
    if (typeof param.cancelScheduledValues === 'function') {
      param.cancelScheduledValues(now)
    }

    if (typeof param.setValueAtTime === 'function') {
      param.setValueAtTime(nextValue, now)
      return
    }

    param.value = nextValue
    return
  }

  if (
    typeof param.cancelScheduledValues === 'function' &&
    typeof param.setValueAtTime === 'function' &&
    typeof param.linearRampToValueAtTime === 'function'
  ) {
    param.cancelScheduledValues(now)
    param.setValueAtTime(param.value, now)
    param.linearRampToValueAtTime(nextValue, now + rampSeconds)
    return
  }

  if (typeof param.setValueAtTime === 'function') {
    param.setValueAtTime(nextValue, now)
    return
  }

  param.value = nextValue
}

function setAudioParamValue(
  context: AudioContext,
  param: SchedulableAudioParam,
  nextValue: number,
) {
  scheduleAudioParamValue(context, param, nextValue, 0)
}

function buildBranchForState(
  context: AudioContext,
  branch: MonitorBranch,
  state: MonitorStateSnapshot,
) {
  resetMonitorBranch(branch)

  if (state.monitorBypassed) {
    branch.structureKey = getMonitorStructureKey(state)
    connectMonitorBranch(branch)
    return
  }

  branch.baselineNodes = state.monitorBaselineEnabled
    ? createGraphEqNodes(context, state.baselineCurve)
    : []
  branch.paramStages = getMonitorActiveBands(state.bands).map((band) => ({
    bandId: band.id,
    type: band.type,
    nodes: createFilterNodesForBand(context, band),
  }))
  branch.filterNodes = [
    ...branch.baselineNodes,
    ...branch.paramStages.flatMap((stage) => stage.nodes),
  ]
  branch.structureKey = getMonitorStructureKey(state)
  connectMonitorBranch(branch)
}

function applyGraphEqCurve(
  context: AudioContext,
  branch: MonitorBranch,
  baselineCurve: CurvePoint[],
) {
  if (branch.baselineNodes.length !== GRAPH_EQ_CENTERS.length) {
    return false
  }

  branch.baselineNodes.forEach((node, index) => {
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
  if (stage.nodes.length !== expectedStageCount) {
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

function applyBranchStateParameters(
  context: AudioContext,
  branch: MonitorBranch,
  state: MonitorStateSnapshot,
) {
  if (branch.structureKey !== getMonitorStructureKey(state)) {
    return false
  }

  if (state.monitorBypassed) {
    return branch.filterNodes.length === 0
  }

  if (state.monitorBaselineEnabled) {
    if (!applyGraphEqCurve(context, branch, state.baselineCurve)) {
      return false
    }
  } else if (branch.baselineNodes.length > 0) {
    return false
  }

  const activeBands = getMonitorActiveBands(state.bands)
  if (branch.paramStages.length !== activeBands.length) {
    return false
  }

  for (let index = 0; index < activeBands.length; index += 1) {
    const band = activeBands[index]
    const stage = branch.paramStages[index]

    if (!stage || stage.bandId !== band.id || stage.type !== band.type) {
      return false
    }

    if (!applyBandStageParameters(context, stage, band)) {
      return false
    }
  }

  return true
}

function scheduleBranchCleanup(graph: MonitorGraph, branchKey: MonitorBranchKey) {
  clearBranchCleanup(graph)
  graph.cleanupTimerId = globalThis.setTimeout(() => {
    const branch = branchKey === 'a' ? graph.branchA : graph.branchB
    if (graph.activeBranchKey !== branchKey) {
      resetMonitorBranch(branch)
      setAudioParamValue(
        graph.source.context as AudioContext,
        branch.output.gain,
        0,
      )
    }
    graph.cleanupTimerId = null
  }, GRAPH_CROSSFADE_MS)
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
  const branchA = createMonitorBranch(context)
  const branchB = createMonitorBranch(context)

  configureAnalyser(preAnalyser)
  configureAnalyser(postAnalyser)

  source.connect(dryGain)
  dryGain.connect(context.destination)
  source.connect(wetInput)
  wetInput.connect(preGainNode)
  preGainNode.connect(preAnalyser)
  preGainNode.connect(branchA.entry)
  preGainNode.connect(branchB.entry)
  branchA.output.connect(wetGain)
  branchB.output.connect(wetGain)
  wetGain.connect(context.destination)
  wetGain.connect(postAnalyser)
  branchA.output.gain.value = 1

  return {
    source,
    dryGain,
    wetInput,
    preGainNode,
    wetGain,
    preAnalyser,
    postAnalyser,
    branchA,
    branchB,
    activeBranchKey: 'a',
    filterNodes: [],
    cleanupTimerId: null,
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
  clearBranchCleanup(graph)

  const nextState: MonitorStateSnapshot = {
    bands,
    baselineCurve,
    monitorBypassed,
    monitorBaselineEnabled,
    preGainDb,
  }

  scheduleAudioParamValue(
    context,
    graph.preGainNode.gain,
    dbToLinear(nextState.preGainDb),
    AUDIO_PARAM_RAMP_SECONDS,
  )
  setAudioParamValue(context, graph.dryGain.gain, 0)
  setAudioParamValue(context, graph.wetGain.gain, 1)

  const activeBranch = getActiveBranch(graph)
  if (applyBranchStateParameters(context, activeBranch, nextState)) {
    graph.filterNodes = activeBranch.filterNodes
    return
  }

  if (activeBranch.structureKey === null && graph.filterNodes.length === 0) {
    buildBranchForState(context, activeBranch, nextState)
    setAudioParamValue(context, activeBranch.output.gain, 1)
    graph.filterNodes = activeBranch.filterNodes
    return
  }

  const inactiveBranch = getInactiveBranch(graph)
  const nextBranchKey = graph.activeBranchKey === 'a' ? 'b' : 'a'

  buildBranchForState(context, inactiveBranch, nextState)

  scheduleAudioParamValue(
    context,
    inactiveBranch.output.gain,
    1,
    GRAPH_CROSSFADE_SECONDS,
  )
  scheduleAudioParamValue(
    context,
    activeBranch.output.gain,
    0,
    GRAPH_CROSSFADE_SECONDS,
  )
  graph.activeBranchKey = nextBranchKey
  graph.filterNodes = inactiveBranch.filterNodes
  scheduleBranchCleanup(graph, graph.activeBranchKey === 'a' ? 'b' : 'a')
}

export function disconnectMonitorGraph(graph: MonitorGraph) {
  clearBranchCleanup(graph)
  safeDisconnect(graph.source)
  safeDisconnect(graph.dryGain)
  safeDisconnect(graph.wetInput)
  safeDisconnect(graph.preGainNode)
  safeDisconnect(graph.wetGain)
  safeDisconnect(graph.preAnalyser)
  safeDisconnect(graph.postAnalyser)
  safeDisconnect(graph.branchA.entry)
  safeDisconnect(graph.branchA.output)
  safeDisconnect(graph.branchB.entry)
  safeDisconnect(graph.branchB.output)
  graph.branchA.filterNodes.forEach((node) => safeDisconnect(node))
  graph.branchB.filterNodes.forEach((node) => safeDisconnect(node))
  graph.filterNodes = []
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
  const fftLastSampleAtRef = useRef(0)
  const pendingSnapshotRef = useRef<MonitorStateSnapshot | null>(null)
  const syncTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null)
  const lastSyncAtRef = useRef(0)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [fftOverlay, setFftOverlay] = useState<FftOverlay | null>(null)

  const clearFftOverlay = useEffectEvent(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }

    fftLastSampleAtRef.current = 0

    startTransition(() => {
      setFftOverlay(null)
    })
  })

  const flushPendingGraphSync = useEffectEvent(() => {
    if (syncTimerRef.current !== null) {
      globalThis.clearTimeout(syncTimerRef.current)
      syncTimerRef.current = null
    }

    const context = audioContextRef.current
    const graph = graphRef.current
    const pendingSnapshot = pendingSnapshotRef.current

    if (!context || !graph || !pendingSnapshot) {
      return
    }

    syncMonitorGraph(
      context,
      graph,
      pendingSnapshot.bands,
      pendingSnapshot.baselineCurve,
      pendingSnapshot.monitorBypassed,
      pendingSnapshot.monitorBaselineEnabled,
      pendingSnapshot.preGainDb,
    )
    lastSyncAtRef.current = Date.now()
    setErrorMessage(null)
  })

  const scheduleGraphSync = useEffectEvent(() => {
    if (!pendingSnapshotRef.current || !graphRef.current || !audioContextRef.current) {
      return
    }

    const now = Date.now()
    if (lastSyncAtRef.current === 0) {
      flushPendingGraphSync()
      return
    }

    const elapsed = now - lastSyncAtRef.current
    if (elapsed >= MONITOR_UPDATE_INTERVAL_MS) {
      flushPendingGraphSync()
      return
    }

    if (syncTimerRef.current !== null) {
      return
    }

    syncTimerRef.current = globalThis.setTimeout(() => {
      flushPendingGraphSync()
    }, MONITOR_UPDATE_INTERVAL_MS - elapsed)
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

    const now = performance.now()
    if (now - fftLastSampleAtRef.current < FFT_OVERLAY_SAMPLE_INTERVAL_MS) {
      animationFrameRef.current = requestAnimationFrame(sampleFftOverlay)
      return
    }

    fftLastSampleAtRef.current = now
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
      lastSyncAtRef.current = 0
      pendingSnapshotRef.current = null
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
    pendingSnapshotRef.current = {
      bands,
      baselineCurve,
      monitorBypassed,
      monitorBaselineEnabled,
      preGainDb,
    }
    if (lastSyncAtRef.current === 0) {
      flushPendingGraphSync()
      return
    }

    scheduleGraphSync()
  }, [
    bands,
    baselineCurve,
    monitorBaselineEnabled,
    monitorBypassed,
    preGainDb,
    flushPendingGraphSync,
    scheduleGraphSync,
  ])

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

      if (syncTimerRef.current !== null) {
        globalThis.clearTimeout(syncTimerRef.current)
        syncTimerRef.current = null
      }

      const graph = graphRef.current
      if (graph) {
        disconnectMonitorGraph(graph)
      }

      if (audioContextRef.current) {
        void audioContextRef.current.close()
      }
    }
  }, [clearFftOverlay])

  return {
    errorMessage,
    fftOverlay,
  }
}
