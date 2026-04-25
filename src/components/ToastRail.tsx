import { useEffect, useRef, useState } from 'react'

export type ToastLevel = 'info' | 'warning' | 'error'

export type ToastNotice = {
  id: string
  level: ToastLevel
  message: string
  timestamp: number
}

type ToastRailProps = {
  toasts: ToastNotice[]
  onDismiss: (id: string) => void
  autoHideMs?: number
}

const DEFAULT_AUTO_HIDE_MS = 5000
const EXIT_ANIMATION_MS = 260

function formatTwoDigits(value: number) {
  return value.toString().padStart(2, '0')
}

function formatTimestamp(timestamp: number) {
  const date = new Date(timestamp)
  return `${formatTwoDigits(date.getHours())}:${formatTwoDigits(date.getMinutes())}:${formatTwoDigits(date.getSeconds())}`
}

export function formatToastCopyText(toast: ToastNotice) {
  return `[${toast.level.toUpperCase()}] [${formatTimestamp(toast.timestamp)}] ${toast.message}`
}

export function ToastRail({
  toasts,
  onDismiss,
  autoHideMs = DEFAULT_AUTO_HIDE_MS,
}: ToastRailProps) {
  const onDismissRef = useRef(onDismiss)
  const hideTimeoutsRef = useRef(new Map<string, number>())
  const exitTimeoutsRef = useRef(new Map<string, number>())
  const remainingTimesRef = useRef(new Map<string, number>())
  const startedAtRef = useRef(new Map<string, number>())
  const pausedIdsRef = useRef(new Set<string>())
  const [leavingIds, setLeavingIds] = useState<Record<string, true>>({})

  useEffect(() => {
    onDismissRef.current = onDismiss
  }, [onDismiss])

  function clearHideTimeout(toastId: string) {
    const timeoutId = hideTimeoutsRef.current.get(toastId)
    if (timeoutId === undefined) {
      return
    }

    window.clearTimeout(timeoutId)
    hideTimeoutsRef.current.delete(toastId)
  }

  function clearExitTimeout(toastId: string) {
    const timeoutId = exitTimeoutsRef.current.get(toastId)
    if (timeoutId === undefined) {
      return
    }

    window.clearTimeout(timeoutId)
    exitTimeoutsRef.current.delete(toastId)
  }

  function clearToastTracking(toastId: string) {
    clearHideTimeout(toastId)
    clearExitTimeout(toastId)
    remainingTimesRef.current.delete(toastId)
    startedAtRef.current.delete(toastId)
    pausedIdsRef.current.delete(toastId)
    setLeavingIds((previous) => {
      if (!previous[toastId]) {
        return previous
      }

      const next = { ...previous }
      delete next[toastId]
      return next
    })
  }

  function startHideCountdown(toastId: string, durationMs: number) {
    if (durationMs <= 0) {
      requestDismiss(toastId)
      return
    }

    clearHideTimeout(toastId)
    startedAtRef.current.set(toastId, Date.now())
    remainingTimesRef.current.set(toastId, durationMs)
    const timeoutId = window.setTimeout(() => {
      requestDismiss(toastId)
    }, durationMs)
    hideTimeoutsRef.current.set(toastId, timeoutId)
  }

  function requestDismiss(toastId: string) {
    if (leavingIds[toastId]) {
      return
    }

    clearHideTimeout(toastId)
    setLeavingIds((previous) => {
      if (previous[toastId]) {
        return previous
      }
      return {
        ...previous,
        [toastId]: true,
      }
    })

    clearExitTimeout(toastId)
    const timeoutId = window.setTimeout(() => {
      clearToastTracking(toastId)
      onDismissRef.current(toastId)
    }, EXIT_ANIMATION_MS)
    exitTimeoutsRef.current.set(toastId, timeoutId)
  }

  function pauseHideCountdown(toastId: string) {
    if (pausedIdsRef.current.has(toastId)) {
      return
    }

    pausedIdsRef.current.add(toastId)
    const startedAt = startedAtRef.current.get(toastId) ?? Date.now()
    const elapsed = Date.now() - startedAt
    const currentRemaining = remainingTimesRef.current.get(toastId) ?? autoHideMs
    remainingTimesRef.current.set(toastId, Math.max(0, currentRemaining - elapsed))
    clearHideTimeout(toastId)
    startedAtRef.current.delete(toastId)
  }

  function resumeHideCountdown(toastId: string) {
    if (!pausedIdsRef.current.has(toastId)) {
      return
    }

    pausedIdsRef.current.delete(toastId)
    const durationMs = remainingTimesRef.current.get(toastId) ?? autoHideMs
    startHideCountdown(toastId, durationMs)
  }

  async function handleCopyAndDismiss(toast: ToastNotice) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(formatToastCopyText(toast))
      }
    } catch (error) {
      console.warn('Failed to copy notification text.', error)
    } finally {
      requestDismiss(toast.id)
    }
  }

  useEffect(() => {
    const activeToastIds = new Set(toasts.map((toast) => toast.id))

    toasts.forEach((toast) => {
      if (!remainingTimesRef.current.has(toast.id)) {
        remainingTimesRef.current.set(toast.id, autoHideMs)
      }

      if (!pausedIdsRef.current.has(toast.id) && !hideTimeoutsRef.current.has(toast.id)) {
        startHideCountdown(toast.id, remainingTimesRef.current.get(toast.id) ?? autoHideMs)
      }
    })

    const trackedToastIds = [...remainingTimesRef.current.keys()]
    trackedToastIds.forEach((toastId) => {
      if (activeToastIds.has(toastId)) {
        return
      }

      clearToastTracking(toastId)
    })
  }, [toasts, autoHideMs])

  useEffect(() => {
    return () => {
      ;[...hideTimeoutsRef.current.keys()].forEach((toastId) => clearHideTimeout(toastId))
      ;[...exitTimeoutsRef.current.keys()].forEach((toastId) => clearExitTimeout(toastId))
    }
  }, [])

  return (
    <div className="toast-rail" aria-live="polite" aria-atomic={false}>
      {toasts.map((toast) => {
        const isLeaving = Boolean(leavingIds[toast.id])
        return (
          <button
            key={toast.id}
            type="button"
            className={`toast-item toast-level-${toast.level} ${isLeaving ? 'toast-leave' : 'toast-enter'}`}
            onMouseEnter={() => pauseHideCountdown(toast.id)}
            onMouseLeave={() => resumeHideCountdown(toast.id)}
            onClick={() => void handleCopyAndDismiss(toast)}
          >
            <span className="toast-meta">
              <strong className="toast-level">{toast.level.toUpperCase()}</strong>
              <span className="toast-time">{formatTimestamp(toast.timestamp)}</span>
            </span>
            <span className="toast-message">{toast.message}</span>
          </button>
        )
      })}
    </div>
  )
}
