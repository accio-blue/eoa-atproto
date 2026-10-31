/**
 * `ing.lexicon.ui.prefs` — a user's accessibility and UI preferences, and the
 * one function a host needs to turn the (untrusted) record into the plain
 * values a primitive consumes.
 *
 * The seam: **the host resolves the record and injects the result**;
 * `@cssints/headless` never imports atproto and takes prefs as inputs. Nothing
 * here is styling — colour, type and focus-ring look belong to the look layer
 * (ADR 0002), not to a preference.
 *
 * `resolvePrefs` is defensive on purpose: a record can come from the network,
 * so an unknown enum value, a negative delay or a non-boolean falls back to the
 * default rather than reaching a primitive.
 */

/** The lexicon is the source of truth; this is its hand-typed mirror. */
export const PREFS_NSID = 'ing.lexicon.ui.prefs';

export const MOTION_VALUES = ['system', 'reduce', 'full'] as const;
export type MotionPreference = (typeof MOTION_VALUES)[number];

/** What a primitive consumes: resolved, never `system`, durations in ms. */
export interface UiPrefs {
  readonly motion: 'reduce' | 'full';
  readonly motionDurationMs: number;
  readonly typeaheadDelayMs: number;
  readonly tooltipShowDelayMs: number;
  readonly tooltipHideDelayMs: number;
  readonly announce: boolean;
  readonly focusFollowsCamera: boolean;
}

/** The stored record: one per repo (key `literal:self`), every field optional. */
export interface UiPrefsRecord {
  readonly $type: typeof PREFS_NSID;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly motion?: MotionPreference;
  readonly motionDurationMs?: number;
  readonly typeaheadDelayMs?: number;
  readonly tooltipShowDelayMs?: number;
  readonly tooltipHideDelayMs?: number;
  readonly announce?: boolean;
  readonly focusFollowsCamera?: boolean;
}

/** What the environment says, so `motion: 'system'` can be resolved. */
export interface SystemPreferences {
  /** `matchMedia('(prefers-reduced-motion: reduce)').matches`, read by the host. */
  readonly reducedMotion?: boolean;
}

export const UI_PREF_DEFAULTS: UiPrefs = {
  motion: 'full',
  motionDurationMs: 200,
  typeaheadDelayMs: 500,
  tooltipShowDelayMs: 600,
  tooltipHideDelayMs: 300,
  announce: true,
  focusFollowsCamera: true,
};

// The record's static types describe what a well-formed record carries; the
// runtime checks below still hold when the value came off the network.
const motionOf = (
  value: MotionPreference | undefined,
): MotionPreference | undefined =>
  typeof value === 'string' && MOTION_VALUES.includes(value)
    ? value
    : undefined;

const milliseconds = ({
  value,
  fallback,
}: {
  readonly value: number | undefined;
  readonly fallback: number;
}): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;

const flag = ({
  value,
  fallback,
}: {
  readonly value: boolean | undefined;
  readonly fallback: boolean;
}): boolean => (typeof value === 'boolean' ? value : fallback);

export interface ResolvePrefsParams {
  readonly record: UiPrefsRecord | undefined;
  readonly system?: SystemPreferences;
}

/**
 * Merge a stored record with the defaults and the system preference. Returns a
 * fresh object; the record is never mutated.
 */
export const resolvePrefs = ({
  record,
  system = {},
}: ResolvePrefsParams): UiPrefs => {
  const preference = motionOf(record?.motion) ?? 'system';
  const motion =
    preference === 'system'
      ? system.reducedMotion === true
        ? 'reduce'
        : 'full'
      : preference;
  return {
    motion,
    // A reduced-motion preference is a jump, whatever the record asked for.
    motionDurationMs:
      motion === 'reduce'
        ? 0
        : milliseconds({
            value: record?.motionDurationMs,
            fallback: UI_PREF_DEFAULTS.motionDurationMs,
          }),
    typeaheadDelayMs: milliseconds({
      value: record?.typeaheadDelayMs,
      fallback: UI_PREF_DEFAULTS.typeaheadDelayMs,
    }),
    tooltipShowDelayMs: milliseconds({
      value: record?.tooltipShowDelayMs,
      fallback: UI_PREF_DEFAULTS.tooltipShowDelayMs,
    }),
    tooltipHideDelayMs: milliseconds({
      value: record?.tooltipHideDelayMs,
      fallback: UI_PREF_DEFAULTS.tooltipHideDelayMs,
    }),
    announce: flag({
      value: record?.announce,
      fallback: UI_PREF_DEFAULTS.announce,
    }),
    focusFollowsCamera: flag({
      value: record?.focusFollowsCamera,
      fallback: UI_PREF_DEFAULTS.focusFollowsCamera,
    }),
  };
};
