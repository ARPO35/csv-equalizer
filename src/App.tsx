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
import { createDefaultBand, describeBand, sortBandsByFrequency } from './lib/bands'
import { parseCurveCsv } from './lib/csv'
import { computeEqCurve, sumCurveWithEq } from './lib/eq'
import {
  saveTextFile,
  serializeCurveCsv,
  serializePreset,
} from './lib/files'
import { EqEditorProvider, useEqEditor } from './state'
import type { EqBand, EqBandType, ProjectPresetV1 } from './types'

function formatDb(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`
}

function clampFrequency(value: number) {
  return Math.min(20_000, Math.max(20, value))
}

function getSelectedBand(bands: EqBand[], selectedBandId?: string) {
  return bands.find((band) => band.id === selectedBandId)
}

function EditorShell() {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const presetHandleRef = useRef<FileSystemFileHandle | null>(null)
  const exportHandleRef = useRef<FileSystemFileHandle | null>(null)
  const { state, dispatch } = useEqEditor()
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const bandCurve = useMemo(
    () =>
      computeEqCurve(
        state.bands,
        state.baselineCurve.map((point) => point.frequencyHz),
      ),
    [state.bands, state.baselineCurve],
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

  function updateBand(nextBand: EqBand) {
    dispatch({ type: 'update-band', payload: nextBand })
  }

  function handleRemoveBand(bandId: string) {
    dispatch({ type: 'remove-band', payload: { id: bandId } })
  }

  function handleImportClick() {
    fileInputRef.current?.click()
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
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to parse CSV file.'
      dispatch({ type: 'set-error', payload: message })
    } finally {
      event.target.value = ''
    }
  }

  function handleAddBand() {
    dispatch({ type: 'add-band', payload: createDefaultBand('peaking') })
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

  function handleBandTypeChange(nextType: EqBandType) {
    if (!selectedBand) {
      return
    }

    const nextBand = createDefaultBand(nextType, {
      frequencyHz: selectedBand.frequencyHz,
      gainDb: 'gainDb' in selectedBand ? selectedBand.gainDb : undefined,
      id: selectedBand.id,
    })

    updateBand(nextBand)
  }

  function handleFieldChange(
    field: 'frequencyHz' | 'gainDb' | 'q' | 'slopeDbPerOct',
    rawValue: string,
  ) {
    if (!selectedBand) {
      return
    }

    const numericValue = Number(rawValue)
    if (Number.isNaN(numericValue)) {
      return
    }

    if (field === 'frequencyHz') {
      updateBand({
        ...selectedBand,
        frequencyHz: clampFrequency(numericValue),
      })
      return
    }

    if (field === 'gainDb' && 'gainDb' in selectedBand) {
      updateBand({
        ...selectedBand,
        gainDb: numericValue,
      })
      return
    }

    if (field === 'q' && selectedBand.type === 'peaking') {
      updateBand({
        ...selectedBand,
        q: Math.max(0.1, numericValue),
      })
      return
    }

    if (field === 'slopeDbPerOct' && 'slopeDbPerOct' in selectedBand) {
      updateBand({
        ...selectedBand,
        slopeDbPerOct: numericValue as 12 | 24 | 36 | 48,
      })
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <p className="eyebrow">CSV headphone equalizer</p>
          <div>
            <h1>Curve Studio</h1>
            <p className="subtitle">
              Parametric EQ editing for headphone response curves in a focused
              desktop-style workspace.
            </p>
          </div>
        </div>

        <div className="topbar-actions">
          <input
            ref={fileInputRef}
            className="hidden-input"
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
          />
          <button type="button" className="ghost-button" onClick={handleImportClick}>
            Import CSV
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
            Export curve
          </button>
        </div>
      </header>

      <main className="workspace">
        <aside className="panel panel-left">
          <section className="panel-section">
            <p className="section-label">Session</p>
            <div className="metric-grid">
              <article>
                <span>Source</span>
                <strong>{state.sourceFileName ?? 'No CSV loaded'}</strong>
              </article>
              <article>
                <span>Points</span>
                <strong>{state.baselineCurve.length}</strong>
              </article>
              <article>
                <span>Bands</span>
                <strong>{state.bands.length}</strong>
              </article>
              <article>
                <span>EQ peak</span>
                <strong>
                  {bandCurve.length === 0
                    ? '0.0 dB'
                    : formatDb(
                        Math.max(...bandCurve.map((point) => point.gainDb)),
                      )}
                </strong>
              </article>
            </div>
          </section>

          <section className="panel-section">
            <p className="section-label">Workflow</p>
            <ol className="workflow-list">
              <li>Import an EQ curve or start from flat immediately.</li>
              <li>Create parametric bands and shape the response.</li>
              <li>Save the preset with Ctrl+S and export the final EQ curve.</li>
            </ol>
          </section>

          {state.errorMessage ? (
            <section className="panel-section">
              <p className="section-label">Import status</p>
              <div className="status-box status-error">{state.errorMessage}</div>
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
              <h2>EQ curve editor</h2>
            </div>
            <div className="legend">
              <span className="legend-item legend-source">Baseline</span>
              <span className="legend-item legend-eq">Param EQ</span>
              <span className="legend-item legend-preview">Output</span>
            </div>
          </div>

          <EqChart
            sourceCurve={state.baselineCurve}
            eqCurve={bandCurve}
            adjustedCurve={outputCurve}
            bands={state.bands}
            selectedBandId={state.selectedBandId}
            onBandChange={(bandId, nextValues) => {
              const band = state.bands.find((entry) => entry.id === bandId)
              if (!band) {
                return
              }

              if ('gainDb' in band) {
                updateBand({
                  ...band,
                  frequencyHz: clampFrequency(nextValues.frequencyHz),
                  gainDb:
                    nextValues.gainDb === undefined
                      ? band.gainDb
                      : Math.max(-24, Math.min(24, nextValues.gainDb)),
                })
                return
              }

              updateBand({
                ...band,
                frequencyHz: clampFrequency(nextValues.frequencyHz),
              })
            }}
            onBandSelect={(bandId) =>
              dispatch({ type: 'select-band', payload: { id: bandId } })
            }
          />
        </section>

        <aside className="panel panel-right">
          <section className="panel-section">
            <div className="stack-header">
              <div>
                <p className="section-label">Bands</p>
                <h2>Parametric stack</h2>
              </div>
              <button type="button" className="ghost-button" onClick={handleAddBand}>
                Add band
              </button>
            </div>

            {state.bands.length === 0 ? (
              <div className="empty-band-list">
                <p>No filters yet.</p>
                <span>
                  Bell, shelves and cut filters will appear here after import.
                </span>
              </div>
            ) : (
              <div className="band-list">
                {sortBandsByFrequency(state.bands).map((band, index) => (
                  <button
                    key={band.id}
                    type="button"
                    className={`band-item ${
                      band.id === state.selectedBandId ? 'is-selected' : ''
                    }`}
                    onClick={() =>
                      dispatch({ type: 'select-band', payload: { id: band.id } })
                    }
                  >
                    <span className="band-index">{index + 1}</span>
                    <div className="band-copy">
                      <strong>{describeBand(band)}</strong>
                      <span>{band.frequencyHz.toFixed(0)} Hz</span>
                    </div>
                    {'gainDb' in band ? (
                      <span className="band-value">{formatDb(band.gainDb)}</span>
                    ) : (
                      <span className="band-value">{band.slopeDbPerOct} dB/oct</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="panel-section">
            <p className="section-label">Inspector</p>
            {!selectedBand ? (
              <div className="inspector-card">
                <h3>Select a band</h3>
                <p>
                  The right panel will expose exact frequency, gain, Q and slope
                  controls for the current filter.
                </p>
              </div>
            ) : (
              <form className="band-form" onSubmit={(event) => event.preventDefault()}>
                <label>
                  <span>Type</span>
                  <select
                    value={selectedBand.type}
                    onChange={(event) =>
                      handleBandTypeChange(event.target.value as EqBandType)
                    }
                  >
                    <option value="peaking">Bell</option>
                    <option value="lowShelf">Low shelf</option>
                    <option value="highShelf">High shelf</option>
                    <option value="lowCut">Low cut</option>
                    <option value="highCut">High cut</option>
                  </select>
                </label>

                <label>
                  <span>Frequency (Hz)</span>
                  <input
                    type="number"
                    min={20}
                    max={20_000}
                    step={1}
                    value={selectedBand.frequencyHz}
                    onChange={(event) =>
                      handleFieldChange('frequencyHz', event.target.value)
                    }
                  />
                </label>

                {'gainDb' in selectedBand ? (
                  <label>
                    <span>Gain (dB)</span>
                    <input
                      type="number"
                      min={-24}
                      max={24}
                      step={0.1}
                      value={selectedBand.gainDb}
                      onChange={(event) =>
                        handleFieldChange('gainDb', event.target.value)
                      }
                    />
                  </label>
                ) : null}

                {selectedBand.type === 'peaking' ? (
                  <label>
                    <span>Q</span>
                    <input
                      type="number"
                      min={0.1}
                      max={12}
                      step={0.05}
                      value={selectedBand.q}
                      onChange={(event) => handleFieldChange('q', event.target.value)}
                    />
                  </label>
                ) : null}

                {'slopeDbPerOct' in selectedBand ? (
                  <label>
                    <span>Slope (dB/oct)</span>
                    <select
                      value={selectedBand.slopeDbPerOct}
                      onChange={(event) =>
                        handleFieldChange('slopeDbPerOct', event.target.value)
                      }
                    >
                      <option value={12}>12</option>
                      <option value={24}>24</option>
                      <option value={36}>36</option>
                      <option value={48}>48</option>
                    </select>
                  </label>
                ) : null}

                <button
                  type="button"
                  className="ghost-button band-delete"
                  onClick={() => handleRemoveBand(selectedBand.id)}
                >
                  Delete band
                </button>
              </form>
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
