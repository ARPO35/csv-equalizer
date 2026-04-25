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
import { ToastRail, type ToastLevel, type ToastNotice } from './components/ToastRail'
import { useAppliedBands } from './lib/applied-bands'
import { FFT_SIZE_OPTIONS, useEqPlaybackMonitor } from './lib/audio-monitor'
import { describeBand, sortBandsByFrequency } from './lib/bands'
import { createLogFrequencyGrid, resampleCurve } from './lib/curve'
import { parseCurveCsv } from './lib/csv'
import { computeEqCurve, sumCurveWithEq } from './lib/eq'
import {
  type ExportAlignment,
  getExportFormats,
  getExportFrequencies,
  prepareExportCurve,
  serializeExportCurve,
} from './lib/export'
import { computeAutoPreGainDb } from './lib/pre-gain'
import {
  saveTextFile,
  serializePreset,
} from './lib/files'
import { EqEditorProvider, useEqEditor } from './state'
import type { BandUpdateMode, EqBand, ProjectPresetV1 } from './types'

function formatDb(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`
}

function isAbortError(error: unknown) {
  if (error instanceof DOMException) {
    return error.name === 'AbortError'
  }

  if (typeof error !== 'object' || !error) {
    return false
  }

  return 'name' in error && error.name === 'AbortError'
}

function formatPlaybackTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '00:00'
  }

  const totalSeconds = Math.floor(seconds)
  const minutes = Math.floor(totalSeconds / 60)
  const remainingSeconds = totalSeconds % 60

  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
}

function getFiniteDuration(audio: HTMLAudioElement) {
  return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
}

function clampPlaybackRatio(value: number) {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.min(1000, Math.max(0, value))
}

function EditorShell() {
  const curveInputRef = useRef<HTMLInputElement | null>(null)
  const audioInputRef = useRef<HTMLInputElement | null>(null)
  const presetHandleRef = useRef<FileSystemFileHandle | null>(null)
  const exportHandlesRef = useRef(new Map<string, FileSystemFileHandle | null>())
  const audioObjectUrlRef = useRef<string | null>(null)
  const nextToastIdRef = useRef(0)
  const lastMonitorErrorRef = useRef<string | null>(null)
  const lastAudibleVolumeRef = useRef(1)
  const { state, dispatch } = useEqEditor()
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [durationSec, setDurationSec] = useState(0)
  const [currentTimeSec, setCurrentTimeSec] = useState(0)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [isSeeking, setIsSeeking] = useState(false)
  const [seekRatio, setSeekRatio] = useState(0)
  const [toasts, setToasts] = useState<ToastNotice[]>([])
  const [isEditingPreGain, setIsEditingPreGain] = useState(false)
  const [preGainDraft, setPreGainDraft] = useState('')
  const [isEditingVisualGain, setIsEditingVisualGain] = useState(false)
  const [visualGainDraft, setVisualGainDraft] = useState('')
  const [isEditingFftSize, setIsEditingFftSize] = useState(false)
  const [fftSizeDraft, setFftSizeDraft] = useState('')
  const exportFormats = useMemo(() => getExportFormats(), [])
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false)
  const [selectedExportFormatId, setSelectedExportFormatId] = useState(
    () => exportFormats[0]?.id ?? '',
  )
  const selectedExportFormat =
    exportFormats.find((format) => format.id === selectedExportFormatId) ??
    exportFormats[0]
  const [exportPointCount, setExportPointCount] = useState(
    () => selectedExportFormat?.defaultPointCount ?? 512,
  )
  const [exportAlignment, setExportAlignment] =
    useState<ExportAlignment>('current')
  const [shouldInvertExport, setShouldInvertExport] = useState(false)
  const { appliedBands, flushAppliedBands, markNextBandChange } = useAppliedBands(
    state.bands,
  )

  const activeBands = useMemo(
    () => appliedBands.filter((band) => !band.isBypassed),
    [appliedBands],
  )
  const workingFrequencies = useMemo(
    () => createLogFrequencyGrid(),
    [],
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
  const canExportCurve = workingBaselineCurve.length > 0 && exportFormats.length > 0
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
    fftSize: state.fftSize,
  })

  const pushToast = useEffectEvent((level: ToastLevel, message: string) => {
    nextToastIdRef.current += 1
    const id = `toast-${Date.now()}-${nextToastIdRef.current}`
    const timestamp = Date.now()
    setToasts((previous) => [...previous, { id, level, message, timestamp }])
  })

  const dismissToast = useEffectEvent((toastId: string) => {
    setToasts((previous) => previous.filter((toast) => toast.id !== toastId))
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

  function commitFftSize() {
    const nextValue = Math.round(Number(fftSizeDraft))
    if (!Number.isNaN(nextValue)) {
      const nearestFftSize = FFT_SIZE_OPTIONS.reduce((best, option) =>
        Math.abs(option - nextValue) < Math.abs(best - nextValue) ? option : best,
      )
      dispatch({
        type: 'set-fft-size',
        payload: nearestFftSize,
      })
    }
    setIsEditingFftSize(false)
    setFftSizeDraft('')
  }

  function startFftSizeEdit() {
    setIsEditingFftSize(true)
    setFftSizeDraft(state.fftSize.toString())
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
    if (monitorErrorMessage) {
      if (monitorErrorMessage !== lastMonitorErrorRef.current) {
        pushToast('error', monitorErrorMessage)
      }
      lastMonitorErrorRef.current = monitorErrorMessage
      return
    }

    if (lastMonitorErrorRef.current) {
      pushToast('warning', 'Monitor recovered from previous error.')
    }
    lastMonitorErrorRef.current = null
  }, [monitorErrorMessage, pushToast])

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

  useEffect(() => {
    if (!audioElement) {
      setIsPlaying(false)
      setDurationSec(0)
      setCurrentTimeSec(0)
      setVolume(1)
      setIsMuted(false)
      setIsSeeking(false)
      setSeekRatio(0)
      lastAudibleVolumeRef.current = 1
      return
    }

    const audio = audioElement

    function syncDuration() {
      setDurationSec(getFiniteDuration(audio))
    }

    function syncCurrentTime() {
      setCurrentTimeSec(audio.currentTime)
    }

    function syncVolume() {
      const nextVolume = audio.volume
      setVolume(nextVolume)
      setIsMuted(audio.muted || nextVolume === 0)
      if (nextVolume > 0) {
        lastAudibleVolumeRef.current = nextVolume
      }
    }

    function handlePlay() {
      setIsPlaying(true)
    }

    function handlePause() {
      setIsPlaying(false)
    }

    function handleEnded() {
      setIsPlaying(false)
      syncCurrentTime()
    }

    syncDuration()
    syncCurrentTime()
    syncVolume()
    setIsPlaying(!audio.paused && !audio.ended)

    audio.addEventListener('loadedmetadata', syncDuration)
    audio.addEventListener('durationchange', syncDuration)
    audio.addEventListener('timeupdate', syncCurrentTime)
    audio.addEventListener('play', handlePlay)
    audio.addEventListener('pause', handlePause)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('volumechange', syncVolume)

    return () => {
      audio.removeEventListener('loadedmetadata', syncDuration)
      audio.removeEventListener('durationchange', syncDuration)
      audio.removeEventListener('timeupdate', syncCurrentTime)
      audio.removeEventListener('play', handlePlay)
      audio.removeEventListener('pause', handlePause)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('volumechange', syncVolume)
    }
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

  function handlePlaybackToggle() {
    if (!audioElement) {
      return
    }

    if (audioElement.paused || audioElement.ended) {
      const playResult = audioElement.play()
      if (playResult) {
        playResult.catch((error: unknown) => {
          console.warn('Failed to play monitor audio.', error)
        })
      }
      return
    }

    audioElement.pause()
  }

  function handleSeekPreview(nextRatio: number) {
    setIsSeeking(true)
    setSeekRatio(clampPlaybackRatio(nextRatio))
  }

  function commitSeek(nextRatio = seekRatio) {
    if (!audioElement || durationSec <= 0) {
      setIsSeeking(false)
      return
    }

    const nextTime = (clampPlaybackRatio(nextRatio) / 1000) * durationSec
    audioElement.currentTime = nextTime
    setCurrentTimeSec(nextTime)
    setIsSeeking(false)
  }

  function handleVolumeChange(nextVolume: number) {
    if (!audioElement) {
      return
    }

    const normalizedVolume = Math.min(1, Math.max(0, nextVolume))
    audioElement.volume = normalizedVolume
    audioElement.muted = normalizedVolume === 0
    setVolume(normalizedVolume)
    setIsMuted(audioElement.muted)
    if (normalizedVolume > 0) {
      lastAudibleVolumeRef.current = normalizedVolume
    }
  }

  function handleMuteToggle() {
    if (!audioElement) {
      return
    }

    if (audioElement.muted || audioElement.volume === 0) {
      const restoredVolume =
        audioElement.volume > 0 ? audioElement.volume : lastAudibleVolumeRef.current
      audioElement.volume = restoredVolume
      audioElement.muted = false
      setVolume(restoredVolume)
      setIsMuted(false)
      return
    }

    audioElement.muted = true
    setIsMuted(true)
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
      pushToast('info', `Imported EQ CSV: ${file.name}`)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to parse CSV file.'
      pushToast('error', message)
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
      if (result.mode === 'download') {
        pushToast('warning', 'Saved preset via browser download fallback.')
      } else {
        pushToast('info', 'Preset saved successfully.')
      }
    } catch (error) {
      if (isAbortError(error)) {
        pushToast('info', 'Preset save cancelled by user.')
        return
      }
      const message =
        error instanceof Error ? error.message : 'Failed to save preset.'
      pushToast('error', message)
    }
  }

  function openExportDialog() {
    if (!selectedExportFormat) {
      return
    }

    setExportPointCount(selectedExportFormat.defaultPointCount ?? outputCurve.length)
    setIsExportDialogOpen(true)
  }

  async function handleExportCurve() {
    if (!selectedExportFormat) {
      pushToast('error', 'No export formats are configured.')
      return
    }

    try {
      const targetOutputCurve = sumCurveWithEq(
        workingBaselineCurve,
        computeEqCurve(
          state.bands.filter((band) => !band.isBypassed),
          workingFrequencies,
        ),
      )
      const frequencies = getExportFrequencies(
        selectedExportFormat,
        exportPointCount,
      )
      const exportCurve = prepareExportCurve({
        sourceCurve: targetOutputCurve,
        frequencies,
        preGainDb: effectivePreGainDb,
        alignment: exportAlignment,
        invert: shouldInvertExport,
      })
      const result = await saveTextFile({
        suggestedName: `${getBaseFileName()}-eq${selectedExportFormat.extension}`,
        mimeType: selectedExportFormat.mimeType,
        description: selectedExportFormat.label,
        extensions: [selectedExportFormat.extension],
        contents: serializeExportCurve(selectedExportFormat, exportCurve),
        handle: exportHandlesRef.current.get(selectedExportFormat.id) ?? null,
      })
      exportHandlesRef.current.set(selectedExportFormat.id, result.handle)
      setIsExportDialogOpen(false)
      if (result.mode === 'download') {
        pushToast('warning', 'Exported curve via browser download fallback.')
      } else {
        pushToast('info', `Output EQ curve exported as ${selectedExportFormat.label}.`)
      }
    } catch (error) {
      if (isAbortError(error)) {
        pushToast('info', 'Curve export cancelled by user.')
        return
      }
      const message =
        error instanceof Error ? error.message : 'Failed to export EQ curve.'
      pushToast('error', message)
    }
  }

  const sortedBands = sortBandsByFrequency(state.bands)
  const hasSeekableDuration = durationSec > 0
  const progressRatio = hasSeekableDuration
    ? Math.round((currentTimeSec / durationSec) * 1000)
    : 0
  const displayedSeekRatio = isSeeking ? seekRatio : clampPlaybackRatio(progressRatio)
  const displayedCurrentTimeSec = !hasSeekableDuration
    ? 0
    : isSeeking
      ? (displayedSeekRatio / 1000) * durationSec
      : currentTimeSec

  return (
    <div className="app-shell">
      <ToastRail toasts={toasts} onDismiss={dismissToast} />

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
            onClick={openExportDialog}
          >
            Export output
          </button>
        </div>
      </header>

      {isExportDialogOpen && selectedExportFormat ? (
        <div className="modal-backdrop" role="presentation">
          <section
            className="export-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-dialog-title"
          >
            <div className="export-dialog-header">
              <div>
                <p className="section-label">Export output</p>
                <h2 id="export-dialog-title">Choose export format</h2>
              </div>
              <button
                type="button"
                className="band-popover-close"
                aria-label="Close export dialog"
                onClick={() => setIsExportDialogOpen(false)}
              >
                x
              </button>
            </div>

            <div className="export-dialog-body">
              <label className="export-field">
                <span>Format</span>
                <select
                  value={selectedExportFormat.id}
                  onChange={(event) => {
                    const nextFormat = exportFormats.find(
                      (format) => format.id === event.target.value,
                    )
                    if (!nextFormat) {
                      return
                    }
                    setSelectedExportFormatId(nextFormat.id)
                    setExportPointCount(
                      nextFormat.defaultPointCount ?? outputCurve.length,
                    )
                  }}
                >
                  {exportFormats.map((format) => (
                    <option key={format.id} value={format.id}>
                      {format.label}
                    </option>
                  ))}
                </select>
                <small>{selectedExportFormat.description}</small>
              </label>

              <label className="export-field">
                <span>Precision (x-axis points)</span>
                <input
                  type="number"
                  min={16}
                  max={8192}
                  step={1}
                  value={
                    selectedExportFormat.frequencyMode === 'fixed'
                      ? (selectedExportFormat.fixedFrequencies?.length ?? 0)
                      : exportPointCount
                  }
                  disabled={selectedExportFormat.frequencyMode === 'fixed'}
                  onChange={(event) => {
                    const nextValue = Math.round(Number(event.target.value))
                    if (!Number.isNaN(nextValue)) {
                      setExportPointCount(Math.min(8192, Math.max(16, nextValue)))
                    }
                  }}
                />
                {selectedExportFormat.frequencyMode === 'fixed' ? (
                  <small>This format uses a fixed frequency grid.</small>
                ) : null}
              </label>

              <fieldset className="export-fieldset">
                <legend>Alignment</legend>
                <label>
                  <input
                    type="radio"
                    name="export-alignment"
                    checked={exportAlignment === 'current'}
                    onChange={() => setExportAlignment('current')}
                  />
                  Current EQ editor + Pre-Gain
                </label>
                <label>
                  <input
                    type="radio"
                    name="export-alignment"
                    checked={exportAlignment === 'max-to-zero'}
                    onChange={() => setExportAlignment('max-to-zero')}
                  />
                  Align highest point to 0 dB
                </label>
                <label>
                  <input
                    type="radio"
                    name="export-alignment"
                    checked={exportAlignment === 'min-to-zero'}
                    onChange={() => setExportAlignment('min-to-zero')}
                  />
                  Align lowest point to 0 dB
                </label>
              </fieldset>

              <label className="export-toggle">
                <input
                  type="checkbox"
                  checked={shouldInvertExport}
                  onChange={(event) => setShouldInvertExport(event.target.checked)}
                />
                Invert Y axis before alignment
              </label>
            </div>

            <div className="export-dialog-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => setIsExportDialogOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="accent-button"
                onClick={() => void handleExportCurve()}
              >
                Export
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <main className="workspace">
        <aside className="panel panel-monitor">
          <section className="panel-section">
            <p className="section-label">Monitor</p>
            <div className="monitor-toggle-row">
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
            <div className="monitor-stack">
              <button
                type="button"
                className="monitor-card monitor-card-button"
                aria-label="Upload monitor audio"
                onClick={handleAudioUploadClick}
              >
                <strong>{state.audioFileName ?? 'No monitor file loaded'}</strong>
                <p>
                  {state.audioFileName
                    ? 'Click here to upload another monitor audio file.'
                    : 'Click here to upload monitor audio.'}
                </p>
              </button>

              <audio
                ref={setAudioElement}
                className="monitor-player"
                preload="metadata"
              />
              <div className="monitor-controls" aria-label="Monitor playback controls">
                <button
                  type="button"
                  className="monitor-control-button"
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                  onClick={handlePlaybackToggle}
                  disabled={!state.audioFileName}
                >
                  {isPlaying ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>
                <label className="monitor-range-field monitor-position-field">
                  <span className="sr-only">Monitor position</span>
                  <input
                    type="range"
                    min="0"
                    max="1000"
                    step="1"
                    value={displayedSeekRatio}
                    aria-label="Monitor position"
                    disabled={!hasSeekableDuration}
                    onChange={(event) => handleSeekPreview(Number(event.target.value))}
                    onMouseUp={(event) => commitSeek(Number(event.currentTarget.value))}
                    onTouchEnd={(event) => commitSeek(Number(event.currentTarget.value))}
                    onKeyUp={(event) => commitSeek(Number(event.currentTarget.value))}
                    onBlur={(event) => {
                      if (isSeeking) {
                        commitSeek(Number(event.currentTarget.value))
                      }
                    }}
                  />
                </label>
                <span className="monitor-time">
                  {formatPlaybackTime(displayedCurrentTimeSec)}
                </span>
                <button
                  type="button"
                  className="monitor-control-button"
                  aria-label={isMuted ? 'Unmute' : 'Mute'}
                  onClick={handleMuteToggle}
                  disabled={!state.audioFileName}
                >
                  {isMuted ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M4 9v6h4l5 4V5L8 9H4z" />
                      <path d="m16.3 8.3-1.4 1.4 2.3 2.3-2.3 2.3 1.4 1.4 2.3-2.3 2.3 2.3 1.4-1.4-2.3-2.3 2.3-2.3-1.4-1.4-2.3 2.3-2.3-2.3z" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path d="M4 9v6h4l5 4V5L8 9H4z" />
                      <path d="M16 8.4v2.1c.7.4 1 1 1 1.5s-.3 1.1-1 1.5v2.1c1.9-.7 3-2 3-3.6s-1.1-2.9-3-3.6z" />
                      <path d="M16 4.5v2c2.7.9 4.5 3 4.5 5.5S18.7 16.6 16 17.5v2c3.8-1 6.5-3.9 6.5-7.5S19.8 5.5 16 4.5z" />
                    </svg>
                  )}
                </button>
                <label className="monitor-range-field monitor-volume-field">
                  <span className="sr-only">Monitor volume</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={volume}
                    aria-label="Monitor volume"
                    disabled={!audioElement}
                    onChange={(event) => handleVolumeChange(Number(event.target.value))}
                  />
                </label>
              </div>
            </div>
          </section>

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
                <span>FFT Size</span>
                <div className="metric-inline-row">
                  {isEditingFftSize ? (
                    <input
                      aria-label="FFT size"
                      className="metric-inline-input"
                      type="number"
                      autoFocus
                      step={1}
                      list="fft-size-options"
                      value={fftSizeDraft}
                      onChange={(event) => setFftSizeDraft(event.target.value)}
                      onBlur={commitFftSize}
                      onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                        if (event.key === 'Enter') {
                          commitFftSize()
                        }
                        if (event.key === 'Escape') {
                          setIsEditingFftSize(false)
                          setFftSizeDraft('')
                        }
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      aria-label="Edit FFT size"
                      className="metric-inline-value"
                      onDoubleClick={startFftSizeEdit}
                    >
                      {state.fftSize}
                    </button>
                  )}
                  <datalist id="fft-size-options">
                    {FFT_SIZE_OPTIONS.map((option) => (
                      <option key={option} value={option} />
                    ))}
                  </datalist>
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
