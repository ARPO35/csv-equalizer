import {
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react'
import './App.css'
import { EqChart } from './components/EqChart'
import { useAppliedBands } from './lib/applied-bands'
import { useEqPlaybackMonitor } from './lib/audio-monitor'
import { describeBand, sortBandsByFrequency } from './lib/bands'
import { createLogFrequencyGrid, resampleCurve } from './lib/curve'
import { parseCurveCsv } from './lib/csv'
import { computeEqCurve, sumCurveWithEq } from './lib/eq'
import { computeAutoPreGainDb } from './lib/pre-gain'
import {
  saveTextFile,
  serializeCurveCsv,
  serializePreset,
} from './lib/files'
import { EqEditorProvider, useEqEditor } from './state'
import type { BandUpdateMode, EqBand, ProjectPresetV1 } from './types'

function formatDb(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`
}

function EditorShell() {
  const curveInputRef = useRef<HTMLInputElement | null>(null)
  const audioInputRef = useRef<HTMLInputElement | null>(null)
  const presetHandleRef = useRef<FileSystemFileHandle | null>(null)
  const exportHandleRef = useRef<FileSystemFileHandle | null>(null)
  const audioObjectUrlRef = useRef<string | null>(null)
  const { state, dispatch } = useEqEditor()
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null)
  const [isEditingPreGain, setIsEditingPreGain] = useState(false)
  const [preGainDraft, setPreGainDraft] = useState('')
  const [isEditingVisualGain, setIsEditingVisualGain] = useState(false)
  const [visualGainDraft, setVisualGainDraft] = useState('')
  const [isEditingGridPoints, setIsEditingGridPoints] = useState(false)
  const [gridPointDraft, setGridPointDraft] = useState('')
  const { appliedBands, flushAppliedBands, markNextBandChange } = useAppliedBands(
    state.bands,
  )

  const activeBands = useMemo(
    () => appliedBands.filter((band) => !band.isBypassed),
    [appliedBands],
  )
  const workingFrequencies = useMemo(
    () => createLogFrequencyGrid(state.gridPointCount),
    [state.gridPointCount],
  )
  const workingBaselineCurve = useMemo(
    () => resampleCurve(state.baselineCurve, workingFrequencies),
    [state.baselineCurve, workingFrequencies],
  )

  const bandCurve = useMemo(
    () => computeEqCurve(activeBands, workingFrequencies),
    [activeBands, workingFrequencies],
  )

  const outputCurve = useMemo(
    () => sumCurveWithEq(workingBaselineCurve, bandCurve),
    [bandCurve, workingBaselineCurve],
  )

  const rawOutputPeakDb = useMemo(
    () =>
      outputCurve.length === 0
        ? 0
        : Math.max(...outputCurve.map((point) => point.gainDb)),
    [outputCurve],
  )
  const autoPreGainDb = computeAutoPreGainDb(rawOutputPeakDb)
  const effectivePreGainDb =
    state.preGainMode === 'auto' ? autoPreGainDb : state.manualPreGainDb
  const hasClipRisk = rawOutputPeakDb + effectivePreGainDb > 0
  const canSavePreset = Boolean(state.sourceFileName) || state.bands.length > 0
  const canExportCurve = workingBaselineCurve.length > 0
  const preset = useMemo<ProjectPresetV1>(
    () => ({
      version: 1,
      sourceFileName: state.sourceFileName,
      bands: state.bands,
    }),
    [state.bands, state.sourceFileName],
  )
  const { errorMessage: monitorErrorMessage, fftStore, hasFftFrame } = useEqPlaybackMonitor({
    audioElement,
    bands: appliedBands,
    baselineCurve: state.baselineCurve,
    monitorBypassed: state.monitorBypassed,
    monitorBaselineEnabled: state.monitorBaselineEnabled,
    preGainDb: effectivePreGainDb,
  })

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

  function commitManualPreGain() {
    const nextValue = Number(preGainDraft)
    if (!Number.isNaN(nextValue)) {
      dispatch({ type: 'set-manual-pre-gain-db', payload: nextValue })
    }
    setIsEditingPreGain(false)
    setPreGainDraft('')
  }

  function startManualPreGainEdit() {
    if (state.preGainMode !== 'manual') {
      return
    }

    setIsEditingPreGain(true)
    setPreGainDraft(state.manualPreGainDb.toFixed(1))
  }

  function commitVisualGain() {
    const nextValue = Number(visualGainDraft)
    if (!Number.isNaN(nextValue)) {
      dispatch({ type: 'set-visual-gain-db', payload: nextValue })
    }
    setIsEditingVisualGain(false)
    setVisualGainDraft('')
  }

  function startVisualGainEdit() {
    setIsEditingVisualGain(true)
    setVisualGainDraft(state.visualGainDb.toFixed(1))
  }

  function commitGridPoints() {
    const nextValue = Math.round(Number(gridPointDraft))
    if (!Number.isNaN(nextValue)) {
      dispatch({
        type: 'set-grid-point-count',
        payload: Math.min(8192, Math.max(16, nextValue)),
      })
    }
    setIsEditingGridPoints(false)
    setGridPointDraft('')
  }

  function startGridPointsEdit() {
    setIsEditingGridPoints(true)
    setGridPointDraft(state.gridPointCount.toString())
  }

  const handleDeleteSelectedBand = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') {
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

  function updateBand(nextBand: EqBand, mode: BandUpdateMode) {
    const currentBand = state.bands.find((band) => band.id === nextBand.id)
    if (currentBand === nextBand) {
      if (mode === 'immediate') {
        flushAppliedBands()
      }
      return
    }

    if (
      currentBand &&
      currentBand.id === nextBand.id &&
      currentBand.type === nextBand.type &&
      currentBand.frequencyHz === nextBand.frequencyHz &&
      currentBand.isBypassed === nextBand.isBypassed &&
      currentBand.slopeDbPerOct === nextBand.slopeDbPerOct &&
      ('gainDb' in currentBand ? currentBand.gainDb : undefined) ===
        ('gainDb' in nextBand ? nextBand.gainDb : undefined) &&
      ('q' in currentBand ? currentBand.q : undefined) ===
        ('q' in nextBand ? nextBand.q : undefined)
    ) {
      if (mode === 'immediate') {
        flushAppliedBands()
      }
      return
    }

    markNextBandChange(mode)
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
      dispatch({ type: 'set-monitor-baseline-enabled', payload: true })
      dispatch({ type: 'set-error', payload: undefined })
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
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to save preset.'
      dispatch({ type: 'set-error', payload: message })
    }
  }

  async function handleExportCurve() {
    try {
      const targetOutputCurve = sumCurveWithEq(
        workingBaselineCurve,
        computeEqCurve(
          state.bands.filter((band) => !band.isBypassed),
          workingFrequencies,
        ),
      )
      const result = await saveTextFile({
        suggestedName: `${getBaseFileName()}-eq.csv`,
        mimeType: 'text/csv',
        contents: serializeCurveCsv(targetOutputCurve),
        handle: exportHandleRef.current,
      })
      exportHandleRef.current = result.handle
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
        <aside className="panel panel-monitor">
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
              {hasFftFrame ? (
                <>
                  <span className="legend-item legend-fft-pre">Pre-Gain / Pre-EQ</span>
                  <span className="legend-item legend-fft-post">Post FFT Diff</span>
                </>
              ) : null}
            </div>
          </div>

          <EqChart
            baselineCurve={workingBaselineCurve}
            bandCurve={bandCurve}
            outputCurve={outputCurve}
            fftStore={fftStore}
            hasFftFrame={hasFftFrame}
            visualGainDb={state.visualGainDb}
            bands={state.bands}
            selectedBandId={state.selectedBandId}
            viewMinDb={state.viewMinDb}
            viewMaxDb={state.viewMaxDb}
            onBandCommit={updateBand}
            onBandCreate={(band) => dispatch({ type: 'add-band', payload: band })}
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

        <aside className="panel panel-session">
          <section className="panel-section">
            <p className="section-label">Session</p>
            <div className="metric-grid">
              <article>
                <span>Baseline</span>
                <strong>{state.sourceFileName ?? 'Flat 0 dB'}</strong>
              </article>
              <article>
                <span>Grid points</span>
                <div className="metric-inline-row">
                  {isEditingGridPoints ? (
                    <input
                      aria-label="Grid points"
                      className="metric-inline-input"
                      type="number"
                      autoFocus
                      step={1}
                      value={gridPointDraft}
                      onChange={(event) => setGridPointDraft(event.target.value)}
                      onBlur={commitGridPoints}
                      onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                        if (event.key === 'Enter') {
                          commitGridPoints()
                        }
                        if (event.key === 'Escape') {
                          setIsEditingGridPoints(false)
                          setGridPointDraft('')
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      aria-label="Edit grid points"
                      className="metric-inline-value"
                      onDoubleClick={startGridPointsEdit}
                    >
                      {state.gridPointCount}
                    </button>
                  )}
                </div>
              </article>
              <article>
                <span>Bands</span>
                <strong>{activeBands.length} / {state.bands.length}</strong>
              </article>
              <article>
                <span>Visual Gain</span>
                <div className="metric-inline-row">
                  {isEditingVisualGain ? (
                    <input
                      aria-label="Visual gain"
                      className="metric-inline-input"
                      type="number"
                      autoFocus
                      step={0.1}
                      value={visualGainDraft}
                      onChange={(event) => setVisualGainDraft(event.target.value)}
                      onBlur={commitVisualGain}
                      onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                        if (event.key === 'Enter') {
                          commitVisualGain()
                        }
                        if (event.key === 'Escape') {
                          setIsEditingVisualGain(false)
                          setVisualGainDraft('')
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="metric-inline-value"
                      onDoubleClick={startVisualGainEdit}
                    >
                      {formatDb(state.visualGainDb)}
                    </button>
                  )}
                </div>
              </article>
              <article className="pre-gain-card">
                <span>Pre-Gain</span>
                <div className="pre-gain-row">
                  {isEditingPreGain && state.preGainMode === 'manual' ? (
                    <input
                      aria-label="Manual pre-gain"
                      className="pre-gain-input"
                      type="number"
                      autoFocus
                      step={0.1}
                      value={preGainDraft}
                      onChange={(event) => setPreGainDraft(event.target.value)}
                      onBlur={commitManualPreGain}
                      onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                        if (event.key === 'Enter') {
                          commitManualPreGain()
                        }
                        if (event.key === 'Escape') {
                          setIsEditingPreGain(false)
                          setPreGainDraft('')
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className={`pre-gain-value ${hasClipRisk ? 'is-danger' : ''}`}
                      onDoubleClick={startManualPreGainEdit}
                    >
                      {formatDb(effectivePreGainDb)}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`chip-button ${state.preGainMode === 'manual' ? 'is-active' : ''}`}
                    onClick={() =>
                      dispatch({
                        type: 'set-pre-gain-mode',
                        payload: state.preGainMode === 'auto' ? 'manual' : 'auto',
                      })
                    }
                  >
                    {state.preGainMode === 'auto' ? 'Auto' : 'Manual'}
                  </button>
                </div>
              </article>
            </div>
          </section>
        </aside>

        <aside className="panel panel-right">
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
