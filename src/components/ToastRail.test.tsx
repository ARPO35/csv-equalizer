import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatToastCopyText, ToastRail, type ToastNotice } from './ToastRail'

function createToast(overrides: Partial<ToastNotice>): ToastNotice {
  return {
    id: 'toast-1',
    level: 'info',
    message: 'Saved preset successfully.',
    timestamp: Date.now(),
    ...overrides,
  }
}

describe('ToastRail', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-02T12:00:00'))
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders multiple notifications as a stacked rail', () => {
    render(
      <ToastRail
        toasts={[
          createToast({ id: 'toast-1', message: 'Import success.' }),
          createToast({ id: 'toast-2', level: 'warning', message: 'Download fallback.' }),
          createToast({ id: 'toast-3', level: 'error', message: 'Monitor failed.' }),
        ]}
        onDismiss={vi.fn()}
      />,
    )

    const toastButtons = screen.getAllByRole('button')
    expect(toastButtons).toHaveLength(3)
    expect(toastButtons[0].textContent).toContain('Import success.')
    expect(toastButtons[1].textContent).toContain('Download fallback.')
    expect(toastButtons[2].textContent).toContain('Monitor failed.')
  })

  it('auto-hides each notification after 5 seconds plus exit animation', () => {
    const onDismiss = vi.fn()
    render(
      <ToastRail
        toasts={[createToast({ id: 'toast-1' })]}
        onDismiss={onDismiss}
      />,
    )

    act(() => {
      vi.advanceTimersByTime(4999)
    })
    expect(onDismiss).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(onDismiss).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(260)
    })
    expect(onDismiss).toHaveBeenCalledWith('toast-1')
  })

  it('pauses auto-hide on hover and resumes with remaining time on mouse leave', () => {
    const onDismiss = vi.fn()
    render(
      <ToastRail
        toasts={[createToast({ id: 'toast-1' })]}
        onDismiss={onDismiss}
      />,
    )

    const toast = screen.getByRole('button')
    act(() => {
      vi.advanceTimersByTime(3000)
    })

    fireEvent.mouseEnter(toast)

    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(onDismiss).not.toHaveBeenCalled()

    fireEvent.mouseLeave(toast)

    act(() => {
      vi.advanceTimersByTime(1999)
    })
    expect(onDismiss).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1 + 260)
    })
    expect(onDismiss).toHaveBeenCalledWith('toast-1')
  })

  it('copies formatted content and closes when clicked', async () => {
    const onDismiss = vi.fn()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const toast = createToast({
      id: 'toast-1',
      level: 'warning',
      message: 'Save fallback to download mode.',
      timestamp: new Date('2026-01-02T13:14:15').getTime(),
    })

    render(<ToastRail toasts={[toast]} onDismiss={onDismiss} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button'))
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith(formatToastCopyText(toast))
    const toastButton = screen.getByRole('button')
    expect(toastButton.className).toContain('toast-leave')

    act(() => {
      vi.advanceTimersByTime(260)
    })
    expect(onDismiss).toHaveBeenCalledWith('toast-1')
  })

  it('applies level classes and enter/leave animation classes', async () => {
    const onDismiss = vi.fn()

    render(
      <ToastRail
        toasts={[
          createToast({ id: 'toast-info', level: 'info', message: 'Info message.' }),
          createToast({
            id: 'toast-warning',
            level: 'warning',
            message: 'Warning message.',
          }),
          createToast({ id: 'toast-error', level: 'error', message: 'Error message.' }),
        ]}
        onDismiss={onDismiss}
      />,
    )

    const infoToast = screen.getByText('Info message.').closest('button')
    const warningToast = screen.getByText('Warning message.').closest('button')
    const errorToast = screen.getByText('Error message.').closest('button')

    expect(infoToast?.className).toContain('toast-level-info')
    expect(infoToast?.className).toContain('toast-enter')
    expect(warningToast?.className).toContain('toast-level-warning')
    expect(errorToast?.className).toContain('toast-level-error')

    await act(async () => {
      fireEvent.click(infoToast as HTMLElement)
      await Promise.resolve()
    })
    expect(infoToast?.className).toContain('toast-leave')
  })
})
