import {
  type ChangeEvent,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react'
import './App.css'
import { EqChart } from './components/EqChart'
import { useEqPlaybackMonitor } from './lib/audio-monitor'
import { describeBand, sortBandsByFrequency } from './lib/bands'
import { parseCurveCsv } from './lib/csv'
import { computeEqCurve, sumCurveWithEq } from './lib/eq'
import {
  saveTextFile,
  serializeCurveCsv,
  serializePreset,
} from './lib/files'
import { EqEditorProvider, useEqEditor } from './state'
import type { EqBand, ProjectPresetV1 } from './types'

function formatDb(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`
}

function getSelectedBand(bands: EqBand[], selectedBandId?: string) {
  return bands.find((band) => band.id === selectedBandId)
}

function EditorShell() {
  const curveInputRef = useRef<HTMLInputElement | null>(null)
  const audioInputRef = useRef<HTMLInputElement | null>(null)
  const presetHandleRef = useRef<FileSystemFileHandle | null>(null)
  const exportHandleRef = useRef<FileSystemFileHandle | null>(null)
  const audioObjectUrlRef = useRef<string | null>(null)
  const { state, dispatch } = useEqEditor()
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null)
  const activeBands = useMemo(
    () => state.bands.filter((band) => !band.isBypassed),
    [state.bands],
  )
  const { errorMessage: monitorErrorMessage } = useEqPlaybackMonitor({
    audioElement,
    bands: state.bands,
    baselineCurve: state.baselineCurve,
    monitorBypassed: state.monitorBypassed,
    monitorBaselineEnabled: state.monitorBaselineEnabled,
  })

  const bandCurve = useMemo(
    () =>
      computeEqCurve(
        activeBands,
        state.baselineCurve.map((point) => point.frequencyHz),
      ),
    [activeBands, state.baselineCurve],
  )

  const outputCurve = useMemo(
    () => sumCurveWithEq(state.baselineCurve, bandCurve),
    [bandCurve, state.baselineCurve],
  )

  const selectedBand = getSelectedBand(state.bands, state.selectedBandId)
  const canSavePreset = Boolean(state.sourceFileName) || state.bands.length > 0
  const canExportCurve = outputCurve.length > 0
  const preset = useMemo<ProjectPresetV1>(
    () => ({
      version: 1,
      sourceFileName: state.sourceFileName,
      bands: state.bands,
    }),
    [state.bands, state.sourceFileName],
  )

  function getBaseFileName() {
    const sourceName = state.sourceFileName ?? 'flat-eq'
    return sourceName.replace(/\.csv$/i, '')
  }

  function scaleDbBoundary(value: number, grow: boolean, negative: boolean) {
    const factor = grow ? 1.25 : 1 / 1.25
    const magnitude = Math.min(
      48,
      Math.max(3, Math.round(Math.abs(value) * factor * 10) / 10),
    )
    return negative ? -magnitude : magnitude
  }

  const handleDeleteSelectedBand = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.key !== 'Delete' &&
      event.key !== 'Backspace'
    ) {
      return
    }

    const activeElement = document.activeElement
    if (
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLSelectElement ||
      activeElement instanceof HTMLTextAreaElement
    ) {
      return
    }

    if (!state.selectedBandId) {
      return
    }

    event.preventDefault()
    dispatch({
      type: 'remove-band',
      payload: { id: state.selectedBandId },
    })
  })

  useEffect(() => {
    window.addEventListener('keydown', handleDeleteSelectedBand)
    return () => {
      window.removeEventListener('keydown', handleDeleteSelectedBand)
    }
  }, [handleDeleteSelectedBand])

  const handleSaveShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') {
      return
    }

    if (!canSavePreset) {
      return
    }

    event.preventDefault()
    void handleSavePreset()
  })

  useEffect(() => {
    window.addEventListener('keydown', handleSaveShortcut)
    return () => {
      window.removeEventListener('keydown', handleSaveShortcut)
    }
  }, [handleSaveShortcut])

  useEffect(() => {
    return () => {
      if (audioObjectUrlRef.current) {
        URL.revokeObjectURL(audioObjectUrlRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!audioElement || !audioObjectUrlRef.current) {
      return
    }

    audioElement.src = audioObjectUrlRef.current
    audioElement.load()
  }, [audioElement])

  function updateBand(nextBand: EqBand) {
    dispatch({ type: 'update-band', payload: nextBand })
  }

  function handleRemoveBand(bandId: string) {
    dispatch({ type: 'remove-band', payload: { id: bandId } })
  }

  function handleToggleBandBypass(bandId: string) {
    dispatch({ type: 'toggle-band-bypass', payload: { id: bandId } })
  }

  function handleImportClick() {
    curveInputRef.current?.click()
  }

  function handleAudioUploadClick() {
    audioInputRef.current?.click()
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const text = await file.text()
      const curve = parseCurveCsv(text)
      dispatch({ type: 'set-source-file-name', payload: file.name })
      dispatch({ type: 'set-baseline-curve', payload: curve })
      dispatch({ type: 'set-error', payload: undefined })
      setStatusMessage(`Loaded baseline EQ from ${file.name}.`)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to parse CSV file.'
      dispatch({ type: 'set-error', payload: message })
    } finally {
      event.target.value = ''
    }
  }

  async function handleAudioFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current)
    }

    const objectUrl = URL.createObjectURL(file)
    audioObjectUrlRef.current = objectUrl
    dispatch({ type: 'set-audio-file-name', payload: file.name })

    if (audioElement) {
      audioElement.src = objectUrl
      audioElement.load()
    }

    setStatusMessage(`Loaded monitor audio from ${file.name}.`)
    dispatch({ type: 'set-error', payload: undefined })
    event.target.value = ''
  }

  async function handleSavePreset() {
    try {
      const result = await saveTextFile({
        suggestedName: `${getBaseFileName()}.heq.json`,
        mimeType: 'application/json',
        contents: serializePreset(preset),
        handle: presetHandleRef.current,
      })
      presetHandleRef.current = result.handle
      setStatusMessage(
        result.mode === 'picker'
          ? 'Preset saved to the selected file.'
          : 'Preset downloaded as a local file.',
      )
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to save preset.'
      dispatch({ type: 'set-error', payload: message })
    }
  }

  async function handleExportCurve() {
    try {
      const result = await saveTextFile({
        suggestedName: `${getBaseFileName()}-eq.csv`,
        mimeType: 'text/csv',
        contents: serializeCurveCsv(outputCurve),
        handle: exportHandleRef.current,
      })
      exportHandleRef.current = result.handle
      setStatusMessage(
        result.mode === 'picker'
          ? 'EQ curve exported to the selected file.'
          : 'EQ curve downloaded as CSV.',
      )
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to export EQ curve.'
      dispatch({ type: 'set-error', payload: message })
    }
  }

  const sortedBands = sortBandsByFrequency(state.bands)

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <p className="eyebrow">CSV parametric eq editor</p>
          <div>
            <h1>Curve Studio</h1>
            <p className="subtitle">
              Import a baseline EQ or start from flat, then shape the final
              response directly on the graph in a Q3-style workflow.
            </p>
          </div>
        </div>

        <div className="topbar-actions">
          <input
            ref={curveInputRef}
            className="hidden-input"
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
          />
          <input
            ref={audioInputRef}
            className="hidden-input"
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac"
            onChange={handleAudioFileChange}
          />
          <button type="button" className="ghost-button" onClick={handleImportClick}>
            Import EQ CSV
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={!canSavePreset}
            onClick={() => void handleSavePreset()}
          >
            Save preset
          </button>
          <button
            type="button"
            className="accent-button"
            disabled={!canExportCurve}
            onClick={() => void handleExportCurve()}
          >
            Export output
          </button>
        </div>
      </header>

      <main className="workspace">
        <aside className="panel panel-left">
          <section className="panel-section">
            <p className="section-label">Monitor</p>
            <div className="monitor-stack">
              <div className="monitor-actions">
                <button type="button" className="ghost-button" onClick={handleAudioUploadClick}>
                  Upload audio
                </button>
                <button
                  type="button"
                  className={`chip-button ${state.monitorBaselineEnabled ? 'is-active' : ''}`}
                  aria-pressed={state.monitorBaselineEnabled}
                  disabled={!state.sourceFileName}
                  onClick={() => dispatch({ type: 'toggle-monitor-baseline' })}
                >
                  Baseline monitor
                </button>
                <button
                  type="button"
                  className={`chip-button ${state.monitorBypassed ? 'is-active' : ''}`}
                  aria-pressed={state.monitorBypassed}
                  disabled={!state.audioFileName}
                  onClick={() => dispatch({ type: 'toggle-monitor-bypass' })}
                >
                  Monitor bypass
                </button>
              </div>

              <div className="monitor-card">
                <strong>{state.audioFileName ?? 'No monitor file loaded'}</strong>
                <p>
                  {state.audioFileName
                    ? 'Play the file below to hear the current EQ in real time.'
                    : 'Upload a local audio file to audition the current curve.'}
                </p>
              </div>

              <audio
                ref={setAudioElement}
                className="monitor-player"
                controls
                preload="metadata"
              />
            </div>
          </section>

          <section className="panel-section">
            <p className="section-label">Session</p>
            <div className="metric-grid">
              <article>
                <span>Baseline</span>
                <strong>{state.sourceFileName ?? 'Flat 0 dB'}</strong>
              </article>
              <article>
                <span>Grid points</span>
                <strong>{state.baselineCurve.length}</strong>
              </article>
              <article>
                <span>Bands</span>
                <strong>{activeBands.length} / {state.bands.length}</strong>
              </article>
              <article>
                <span>Output peak</span>
                <strong>
                  {outputCurve.length === 0
                    ? '0.0 dB'
                    : formatDb(
                        Math.max(...outputCurve.map((point) => point.gainDb)),
                      )}
                </strong>
              </article>
            </div>
          </section>

          <section className="panel-section">
            <p className="section-label">Workflow</p>
            <ol className="workflow-list">
              <li>Import a baseline EQ or stay on the flat default curve.</li>
              <li>Double-click inside the graph to create a band.</li>
              <li>Hover a node to inspect it, drag to move, wheel during drag to tune Q.</li>
              <li>Use Band bypass to A/B nodes without deleting them.</li>
              <li>Upload a monitor file and use Baseline monitor or Monitor bypass to A/B playback.</li>
              <li>Save the preset with Ctrl+S and export the final output EQ.</li>
            </ol>
          </section>

          {state.errorMessage ? (
            <section className="panel-section">
              <p className="section-label">Import status</p>
              <div className="status-box status-error">{state.errorMessage}</div>
            </section>
          ) : null}

          {monitorErrorMessage ? (
            <section className="panel-section">
              <p className="section-label">Monitor status</p>
              <div className="status-box status-error">{monitorErrorMessage}</div>
            </section>
          ) : null}

          {statusMessage ? (
            <section className="panel-section">
              <p className="section-label">Latest action</p>
              <div className="status-box status-success">{statusMessage}</div>
            </section>
          ) : null}
        </aside>

        <section className="stage">
          <div className="stage-header">
            <div>
              <p className="section-label">Graph</p>
              <h2>Q3-style EQ editor</h2>
            </div>
            <div className="legend">
              <span className="legend-item legend-source">Baseline</span>
              <span className="legend-item legend-eq">Param EQ</span>
              <span className="legend-item legend-preview">Output</span>
            </div>
          </div>

          <EqChart
            baselineCurve={state.baselineCurve}
            bandCurve={bandCurve}
            outputCurve={outputCurve}
            bands={state.bands}
            selectedBandId={state.selectedBandId}
            showFlatHint={!state.sourceFileName}
            viewMinDb={state.viewMinDb}
            viewMaxDb={state.viewMaxDb}
            onBandCommit={updateBand}
            onBandCreate={(band) =>
              dispatch({ type: 'add-band', payload: band })
            }
            onBandDelete={handleRemoveBand}
            onBandToggleBypass={handleToggleBandBypass}
            onBandSelect={(bandId) =>
              dispatch({
                type: 'select-band',
                payload: bandId ? { id: bandId } : undefined,
              })
            }
            onIncreaseViewMax={() =>
              dispatch({
                type: 'set-view-max-db',
                payload: scaleDbBoundary(state.viewMaxDb, true, false),
              })
            }
            onDecreaseViewMax={() =>
              dispatch({
                type: 'set-view-max-db',
                payload: scaleDbBoundary(state.viewMaxDb, false, false),
              })
            }
            onIncreaseViewMin={() =>
              dispatch({
                type: 'set-view-min-db',
                payload: scaleDbBoundary(state.viewMinDb, true, true),
              })
            }
            onDecreaseViewMin={() =>
              dispatch({
                type: 'set-view-min-db',
                payload: scaleDbBoundary(state.viewMinDb, false, true),
              })
            }
          />
        </section>

        <aside className="panel panel-right">
          <section className="panel-section">
            <p className="section-label">Overview</p>
            <div className="info-stack">
              <div className="inspector-card">
                <h3>{state.sourceFileName ? 'Imported baseline' : 'Flat baseline'}</h3>
                <p>
                  {state.sourceFileName
                    ? 'The imported EQ is preserved as the baseline. Nodes add a parametric delta on top of it.'
                    : 'No import is required. The graph starts from a flat 0 dB baseline across the full working grid.'}
                </p>
              </div>

              <div className="inspector-card">
                <h3>{selectedBand ? 'Selected band' : 'No band selected'}</h3>
                {selectedBand ? (
                  <p>
                    {describeBand(selectedBand)} at{' '}
                    {Math.round(selectedBand.frequencyHz)} Hz
                    {'gainDb' in selectedBand
                      ? `, ${formatDb(selectedBand.gainDb)}`
                      : `, ${selectedBand.slopeDbPerOct} dB/oct`}
                    {selectedBand.isBypassed ? ', bypassed' : ''}
                  </p>
                ) : (
                  <p>
                    Hover or click a node to pin its floating editor. Double-click
                    the graph to create the first band.
                  </p>
                )}
              </div>
            </div>
          </section>

          <section className="panel-section">
            <p className="section-label">Shortcuts</p>
            <ul className="shortcut-list">
              <li>Double-click graph: create a peaking band at the cursor.</li>
              <li>Double-click node: delete that band.</li>
              <li>Double-click popover values: edit frequency, gain, Q or slope.</li>
              <li>Band bypass affects the graph, export and monitor chain.</li>
              <li>Baseline monitor only affects playback.</li>
              <li>Monitor bypass only affects playback.</li>
              <li>Drag a bell node and use the mouse wheel to adjust Q.</li>
              <li>`Ctrl+S` / `Cmd+S`: save the current preset.</li>
              <li>`Delete` / `Backspace`: remove the selected band.</li>
            </ul>
          </section>

          <section className="panel-section">
            <p className="section-label">Active stack</p>
            {sortedBands.length === 0 ? (
              <div className="inspector-card">
                <h3>No parametric bands yet</h3>
                <p>The graph is editable. Add the first node with a double-click.</p>
              </div>
            ) : (
              <div className="readonly-band-list">
                {sortedBands.map((band, index) => (
                  <article
                    key={band.id}
                    className={band.isBypassed ? 'is-bypassed' : undefined}
                  >
                    <span>{index + 1}</span>
                    <div>
                      <strong>{describeBand(band)}</strong>
                      <p>
                        {Math.round(band.frequencyHz)} Hz
                        {'gainDb' in band
                          ? ` · ${formatDb(band.gainDb)}`
                          : ` · ${band.slopeDbPerOct} dB/oct`}
                        {band.isBypassed ? ' · bypassed' : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      className={`chip-button ${band.isBypassed ? 'is-active' : ''}`}
                      aria-pressed={band.isBypassed}
                      onClick={() => handleToggleBandBypass(band.id)}
                    >
                      Band bypass
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
        </aside>
      </main>
    </div>
  )
}

function App() {
  return (
    <EqEditorProvider>
      <EditorShell />
    </EqEditorProvider>
  )
}

export default App






