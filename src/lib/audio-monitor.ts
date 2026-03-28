import { useEffect, useRef, useState } from 'react'
import type { CurvePoint, EqBand } from '../types'

const CUT_Q = Math.SQRT1_2
const GRAPH_EQ_Q = 4.318
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

type AudioContextConstructor = new () => AudioContext

type MonitorGraph = {
  source: MediaElementAudioSourceNode
  dryGain: GainNode
  wetInput: GainNode
  wetGain: GainNode
  filterNodes: BiquadFilterNode[]
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
      : 1

  return Array.from({ length: stageCount }, () => {
    const filter = context.createBiquadFilter()
    filter.frequency.value = band.frequencyHz

    if (band.type === 'peaking') {
      filter.type = 'peaking'
      filter.gain.value = band.gainDb
      filter.Q.value = band.q
      return filter
    }

    if (band.type === 'lowShelf' || band.type === 'highShelf') {
      filter.type = band.type === 'lowShelf' ? 'lowshelf' : 'highshelf'
      filter.gain.value = band.gainDb
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
  const wetGain = context.createGain()

  source.connect(dryGain)
  dryGain.connect(context.destination)
  source.connect(wetInput)
  wetGain.connect(context.destination)

  return {
    source,
    dryGain,
    wetInput,
    wetGain,
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
) {
  safeDisconnect(graph.wetInput)
  graph.filterNodes.forEach((node) => safeDisconnect(node))

  const baselineNodes = monitorBaselineEnabled
    ? createGraphEqNodes(context, baselineCurve)
    : []
  const paramNodes = bands
    .filter((band) => !band.isBypassed)
    .flatMap((band) => createFilterNodesForBand(context, band))
  const filterNodes = [...baselineNodes, ...paramNodes]

  if (filterNodes.length === 0) {
    graph.wetInput.connect(graph.wetGain)
  } else {
    graph.wetInput.connect(filterNodes[0])

    filterNodes.forEach((node, index) => {
      const nextNode = filterNodes[index + 1] ?? graph.wetGain
      node.connect(nextNode)
    })
  }

  graph.dryGain.gain.value = monitorBypassed ? 1 : 0
  graph.wetGain.gain.value = monitorBypassed ? 0 : 1
  graph.filterNodes = filterNodes
}

export function disconnectMonitorGraph(graph: MonitorGraph) {
  safeDisconnect(graph.source)
  safeDisconnect(graph.dryGain)
  safeDisconnect(graph.wetInput)
  safeDisconnect(graph.wetGain)
  graph.filterNodes.forEach((node) => safeDisconnect(node))
}

export function useEqPlaybackMonitor({
  audioElement,
  bands,
  baselineCurve,
  monitorBypassed,
  monitorBaselineEnabled,
}: {
  audioElement: HTMLAudioElement | null
  bands: EqBand[]
  baselineCurve: CurvePoint[]
  monitorBypassed: boolean
  monitorBaselineEnabled: boolean
}) {
  const audioContextRef = useRef<AudioContext | null>(null)
  const graphRef = useRef<MonitorGraph | null>(null)
  const attachedElementRef = useRef<HTMLAudioElement | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

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
      setErrorMessage(null)

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
    )
    setErrorMessage(null)
  }, [bands, baselineCurve, monitorBaselineEnabled, monitorBypassed])

  useEffect(() => {
    return () => {
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
  }
}
