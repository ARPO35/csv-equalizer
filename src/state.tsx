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
  | { type: 'set-baseline-curve'; payload: CurvePoint[] }
  | { type: 'set-bands'; payload: EqBand[] }
  | { type: 'set-error'; payload?: string }
  | { type: 'add-band'; payload: EqBand }
  | { type: 'update-band'; payload: EqBand }
  | { type: 'remove-band'; payload: { id: string } }
  | { type: 'select-band'; payload?: { id: string } }

const initialState: EqEditorState = {
  sourceFileName: undefined,
  baselineCurve: createFlatCurve(),
  bands: [],
  selectedBandId: undefined,
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
