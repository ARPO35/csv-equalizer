import {
  createContext,
  type Dispatch,
  type ReactNode,
  useContext,
  useMemo,
  useReducer,
} from 'react'
import { createFlatCurve } from './lib/curve'
import type { CurvePoint, EqBand, EqEditorState } from './types'

type EqEditorAction =
  | { type: 'set-source-file-name'; payload?: string }
  | { type: 'set-audio-file-name'; payload?: string }
  | { type: 'set-baseline-curve'; payload: CurvePoint[] }
  | { type: 'set-bands'; payload: EqBand[] }
  | { type: 'set-error'; payload?: string }
  | { type: 'add-band'; payload: EqBand }
  | { type: 'update-band'; payload: EqBand }
  | { type: 'toggle-band-bypass'; payload: { id: string } }
  | { type: 'toggle-monitor-bypass' }
  | { type: 'toggle-monitor-baseline' }
  | { type: 'set-monitor-baseline-enabled'; payload: boolean }
  | { type: 'set-view-max-db'; payload: number }
  | { type: 'set-view-min-db'; payload: number }
  | { type: 'set-pre-gain-mode'; payload: 'auto' | 'manual' }
  | { type: 'set-manual-pre-gain-db'; payload: number }
  | { type: 'remove-band'; payload: { id: string } }
  | { type: 'select-band'; payload?: { id: string } }

const initialState: EqEditorState = {
  sourceFileName: undefined,
  baselineCurve: createFlatCurve(),
  bands: [],
  selectedBandId: undefined,
  monitorBypassed: false,
  monitorBaselineEnabled: false,
  viewMaxDb: 15,
  viewMinDb: -15,
  preGainMode: 'auto',
  manualPreGainDb: -8,
  audioFileName: undefined,
  errorMessage: undefined,
}

function eqEditorReducer(
  state: EqEditorState,
  action: EqEditorAction,
): EqEditorState {
  switch (action.type) {
    case 'set-source-file-name':
      return {
        ...state,
        sourceFileName: action.payload,
      }
    case 'set-audio-file-name':
      return {
        ...state,
        audioFileName: action.payload,
      }
    case 'set-baseline-curve':
      return {
        ...state,
        baselineCurve: action.payload,
      }
    case 'set-bands':
      return {
        ...state,
        bands: action.payload,
        selectedBandId: action.payload[0]?.id,
      }
    case 'set-error':
      return {
        ...state,
        errorMessage: action.payload,
      }
    case 'add-band':
      return {
        ...state,
        bands: [...state.bands, action.payload],
        selectedBandId: action.payload.id,
      }
    case 'update-band':
      return {
        ...state,
        bands: state.bands.map((band) =>
          band.id === action.payload.id ? action.payload : band,
        ),
      }
    case 'toggle-band-bypass':
      return {
        ...state,
        bands: state.bands.map((band) =>
          band.id === action.payload.id
            ? { ...band, isBypassed: !band.isBypassed }
            : band,
        ),
      }
    case 'toggle-monitor-bypass':
      return {
        ...state,
        monitorBypassed: !state.monitorBypassed,
      }
    case 'toggle-monitor-baseline':
      return {
        ...state,
        monitorBaselineEnabled: !state.monitorBaselineEnabled,
      }
    case 'set-monitor-baseline-enabled':
      return {
        ...state,
        monitorBaselineEnabled: action.payload,
      }
    case 'set-view-max-db':
      return {
        ...state,
        viewMaxDb: action.payload,
      }
    case 'set-view-min-db':
      return {
        ...state,
        viewMinDb: action.payload,
      }
    case 'set-pre-gain-mode':
      return {
        ...state,
        preGainMode: action.payload,
      }
    case 'set-manual-pre-gain-db':
      return {
        ...state,
        manualPreGainDb: action.payload,
      }
    case 'remove-band': {
      const nextBands = state.bands.filter((band) => band.id !== action.payload.id)
      return {
        ...state,
        bands: nextBands,
        selectedBandId:
          state.selectedBandId === action.payload.id
            ? nextBands.at(-1)?.id
            : state.selectedBandId,
      }
    }
    case 'select-band':
      return {
        ...state,
        selectedBandId: action.payload?.id,
      }
    default:
      return state
  }
}

type EqEditorContextValue = {
  state: EqEditorState
  dispatch: Dispatch<EqEditorAction>
}

const EqEditorContext = createContext<EqEditorContextValue | null>(null)

export function EqEditorProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(eqEditorReducer, initialState)
  const value = useMemo(() => ({ state, dispatch }), [state])
  return (
    <EqEditorContext.Provider value={value}>
      {children}
    </EqEditorContext.Provider>
  )
}

export function useEqEditor() {
  const context = useContext(EqEditorContext)
  if (!context) {
    throw new Error('useEqEditor must be used inside EqEditorProvider')
  }
  return context
}
