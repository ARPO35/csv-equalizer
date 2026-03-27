import { useEffect, useRef, useState } from 'react'
import type { EqBand } from '../types'

const CUT_Q = Math.SQRT1_2

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
  monitorBypassed: boolean,
) {
  safeDisconnect(graph.wetInput)
  graph.filterNodes.forEach((node) => safeDisconnect(node))

  const activeBands = bands.filter((band) => !band.isBypassed)
  const filterNodes = activeBands.flatMap((band) =>
    createFilterNodesForBand(context, band),
  )

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
  monitorBypassed,
}: {
  audioElement: HTMLAudioElement | null
  bands: EqBand[]
  monitorBypassed: boolean
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

    syncMonitorGraph(context, graph, bands, monitorBypassed)
    setErrorMessage(null)
  }, [bands, monitorBypassed])

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
