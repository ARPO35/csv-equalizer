import { describe, expect, it } from 'vitest'
import {
  createMonitorGraph,
  disconnectMonitorGraph,
  syncMonitorGraph,
} from './audio-monitor'
import type { EqBand } from '../types'

class FakeAudioNode {
  connections: FakeAudioNode[] = []

  connect(target: FakeAudioNode) {
    this.connections.push(target)
    return target
  }

  disconnect() {
    this.connections = []
  }
}

class FakeGainNode extends FakeAudioNode {
  gain = { value: 1 }
}

class FakeBiquadFilterNode extends FakeAudioNode {
  type: BiquadFilterType = 'peaking'
  frequency = { value: 1000 }
  gain = { value: 0 }
  Q = { value: 1 }
}

class FakeMediaElementSourceNode extends FakeAudioNode {}

function getConnections(node: unknown) {
  return (node as FakeAudioNode).connections
}

class FakeAudioContext {
  destination = new FakeAudioNode()

  createGain() {
    return new FakeGainNode()
  }

  createBiquadFilter() {
    return new FakeBiquadFilterNode()
  }

  createMediaElementSource() {
    return new FakeMediaElementSourceNode()
  }
}

describe('audio monitor graph', () => {
  it('routes dry and wet monitor paths from the media source', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(
      context,
      document.createElement('audio'),
    )

    expect(getConnections(graph.source)).toHaveLength(2)
    expect(getConnections(graph.dryGain)).toEqual([context.destination])
    expect(getConnections(graph.wetGain)).toEqual([context.destination])
  })

  it('skips bypassed bands and flips gain routing when monitor bypass is enabled', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(
      context,
      document.createElement('audio'),
    )
    const bands: EqBand[] = [
      {
        id: 'band-1',
        type: 'peaking',
        frequencyHz: 1000,
        isBypassed: true,
        gainDb: 4,
        q: 1.1,
      },
      {
        id: 'band-2',
        type: 'highCut',
        frequencyHz: 8000,
        isBypassed: false,
        slopeDbPerOct: 24,
      },
    ]

    syncMonitorGraph(context, graph, bands, true)

    expect(graph.filterNodes).toHaveLength(2)
    expect(
      graph.filterNodes.every(
        (node) => (node as FakeBiquadFilterNode).type === 'lowpass',
      ),
    ).toBe(true)
    expect(graph.dryGain.gain.value).toBe(1)
    expect(graph.wetGain.gain.value).toBe(0)
  })

  it('disconnects the monitor graph cleanly', () => {
    const context = new FakeAudioContext() as unknown as AudioContext
    const graph = createMonitorGraph(
      context,
      document.createElement('audio'),
    )

    syncMonitorGraph(context, graph, [], false)
    disconnectMonitorGraph(graph)

    expect(getConnections(graph.source)).toEqual([])
    expect(getConnections(graph.dryGain)).toEqual([])
    expect(getConnections(graph.wetInput)).toEqual([])
    expect(getConnections(graph.wetGain)).toEqual([])
  })
})
