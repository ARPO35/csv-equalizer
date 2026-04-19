# EQ Rework Plan

## Goal

Unify the EQ graph and playback monitor around one filter descriptor model so `Q` and `slope` have stable, predictable semantics:

- Bell `Q` controls width.
- Bell `slope` controls how flat the top or bottom becomes and how quickly the shoulders fall away.
- Shelf `Q` reshapes the knee.
- Shelf `slope` controls how many shelf stages are stacked.
- Cut `slope` controls attenuation steepness.

## Root Cause

The previous implementation had two fundamental problems:

1. Bell `slope` was implemented as "more stages plus larger Q", so it behaved like a second `Q`.
2. The graph and monitor used different topology builders:
   - graph: coefficient-driven response builder
   - monitor: `filter-stages` plus native `BiquadFilterNode` staging

That split made behavior hard to reason about and impossible to keep aligned over time.

## Chosen Model

### Bell

- `12 dB/oct` remains the baseline single peaking section.
- `24/36/48 dB/oct` build a flat-top or flat-bottom bell from a center peaking section plus symmetric shoulder sections.
- The shoulder positions are derived from the baseline half-gain width, so `Q` still anchors the affected range.
- A per-band solver sets the uniform shoulder gain so the center frequency still lands on the requested gain.

### Shelf

- Shelf slope is built by stacking multiple shelf sections.
- Shelf `Q` is represented by an additional knee-shaping peaking section when the requested Q differs from the default.
- This keeps the parameter model compatible with the monitor chain while making the knee audibly and visually adjustable.

### Cut

- Cut filters remain repeated high-pass or low-pass sections at `12 dB/oct` per section.

## Shared Topology

The single source of truth is `src/lib/filter-coefficients.ts`.

It now owns:

- filter descriptor generation
- section coefficient generation
- graph magnitude evaluation

The monitor consumes the same descriptor topology through `src/lib/audio-monitor.ts`.

Removed:

- `src/lib/filter-stages.ts`

## Validation Rules

The implementation should continue to satisfy these checks:

- Bell `24/36/48` produce a flatter center region than `12`.
- Bell `Q` still changes effective width.
- Bell boost and cut stay approximately mirrored.
- Shelf `Q` changes the knee without materially moving the far plateau.
- Shelf and cut slope changes alter topology and audible steepness.
- Graph and monitor consume the same per-band descriptor topology.

## Regression Surface

The rework must not break:

- EQ node dragging
- wheel-based Q or slope editing
- FFT overlay rendering
- baseline monitor routing
- preset saving
- curve export

## Verification

Run:

```bash
npm test -- --run src\lib\eq.test.ts src\lib\audio-monitor.test.ts src\components\EqChart.test.tsx src\lib\bands.test.ts src\lib\files.test.ts src\lib\applied-bands.test.tsx
npm run build
```
