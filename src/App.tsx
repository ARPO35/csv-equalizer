import './App.css'
import { EqEditorProvider, useEqEditor } from './state'

function EditorShell() {
  const { state } = useEqEditor()

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
          <button type="button" className="ghost-button" disabled>
            Import CSV
          </button>
          <button type="button" className="ghost-button" disabled>
            Save preset
          </button>
          <button type="button" className="accent-button" disabled>
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
                <strong>{state.curve.length}</strong>
              </article>
              <article>
                <span>Bands</span>
                <strong>{state.bands.length}</strong>
              </article>
              <article>
                <span>Preview</span>
                <strong>Ready for engine</strong>
              </article>
            </div>
          </section>

          <section className="panel-section">
            <p className="section-label">Workflow</p>
            <ol className="workflow-list">
              <li>Import a CSV with frequency and gain columns.</li>
              <li>Create parametric bands and shape the response.</li>
              <li>Save the preset with Ctrl+S and export the EQ curve.</li>
            </ol>
          </section>
        </aside>

        <section className="stage">
          <div className="stage-header">
            <div>
              <p className="section-label">Graph</p>
              <h2>Frequency response editor</h2>
            </div>
            <div className="legend">
              <span className="legend-item legend-source">Source</span>
              <span className="legend-item legend-eq">EQ sum</span>
              <span className="legend-item legend-preview">Adjusted</span>
            </div>
          </div>

          <div className="chart-placeholder" aria-label="EQ chart placeholder">
            <div className="grid-lines" aria-hidden="true" />
            <div className="placeholder-copy">
              <p className="section-label">Awaiting data</p>
              <h3>Import a headphone response CSV to begin editing</h3>
              <p>
                The editor will render the source curve, summed EQ response and
                adjusted preview here.
              </p>
            </div>
          </div>
        </section>

        <aside className="panel panel-right">
          <section className="panel-section">
            <div className="stack-header">
              <div>
                <p className="section-label">Bands</p>
                <h2>Parametric stack</h2>
              </div>
              <button type="button" className="ghost-button" disabled>
                Add band
              </button>
            </div>

            <div className="empty-band-list">
              <p>No filters yet.</p>
              <span>
                Bell, shelves and cut filters will appear here after import.
              </span>
            </div>
          </section>

          <section className="panel-section">
            <p className="section-label">Inspector</p>
            <div className="inspector-card">
              <h3>Select a band</h3>
              <p>
                The right panel will expose exact frequency, gain, Q and slope
                controls for the current filter.
              </p>
            </div>
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
