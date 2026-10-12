/**
 * What a service gives the shared segment card (SegmentCardLayer) so its runs'
 * pieces can be inspected and changed the same way in every service: what the
 * piece is (its header), its figures and issues, its options with a pure
 * evaluation of each (what it would change, what it would break), how to
 * apply one (one undo), and how to find the piece again once the run has
 * changed. The card does the rest: placement, the leader and chip, tabs,
 * rows, hover previews, keys.
 */
import type { ReactNode } from 'react';

import type { HvacElement } from '../../../../types';

import type { SegmentDomain, SegmentFocus } from './segmentUiStore';

/** An option row's minimum: its identity, words and state. */
export interface SegmentOptionLike {
  id: string;
  title: string;
  detail: string;
  /** The piece is already like this. */
  current?: boolean;
  /** Why the option cannot be offered here (the row stays, greyed, with the reason). */
  disabledReason?: string;
}

/** An option's evaluation: what it would change, and what it says about it. */
export interface SegmentEvaluationLike {
  optionId: string;
  /** Why it cannot be built; the row greys and says so. */
  refused?: string;
  /** Elements as they would be, and those added or removed. */
  updates: HvacElement[];
  add?: HvacElement[];
  removeIds?: string[];
  /** The undo step's name. */
  action: string;
  /** What else it changes ("2 bends re-angled"). */
  notes: string[];
  newIssues: ReadonlyArray<{ severity: string; code: string; message: string }>;
}

/** The card's header. */
export interface SegmentHead {
  title: string;
  /** The size line ("Ø15.88 · 25 mm insulation"). */
  size: string;
  /** More about it, after the size. */
  detail: string;
  /** A short name on the drawing's chip and in the header ("S-003", "Leg 2"). */
  tag: string;
  /** Header picture. */
  glyph: ReactNode;
  /** Header picture's tint (Tailwind classes), the service's colour. */
  tone: string;
  /** The kind of piece: the card remembers the tab used last per kind. */
  kind: string;
}

export interface SegmentIssueLine {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

/** What a field (a typed value) needs from the card: judge a candidate, show it, apply it. */
export interface SegmentFieldHost<O extends SegmentOptionLike, E extends SegmentEvaluationLike> {
  evaluate: (option: O) => E;
  /** The options judged so far (quick-pick chips show their result from these). */
  evaluations: ReadonlyMap<string, E>;
  onPreview: (option: O | null) => void;
  onHover: (info: { option: O; evaluation: E | undefined } | null) => void;
  onApply: (option: O) => void;
  /** An evaluation's one-line result (the service's figures). */
  result: (evaluation: E) => ReactNode;
}

/** One piece, ready for the card. */
export interface SegmentCardModel<O extends SegmentOptionLike, E extends SegmentEvaluationLike> {
  head: SegmentHead;
  /** The figure strip under the header. */
  figures: ReactNode;
  /** How it is built (behind ⓘ). */
  info: ReactNode;
  issues: SegmentIssueLine[];
  options: O[];
  /** Pure and cached: the same option on the same drawing evaluates once. */
  evaluate: (option: O) => E;
  /** Which tab lists an option as a row: Swap, Add, or neither (shown only by the Edit tab's own fields and chips). */
  tabOf: (option: O) => 'swap' | 'add' | null;
  /** The Edit tab: the piece's own values. */
  edit: (host: SegmentFieldHost<O, E>) => ReactNode | null;
  /** The piece before or after it along the run. */
  neighbour: (direction: -1 | 1) => { key: string; anchorMark: string | null } | null;
  /** Whatever `rekey` needs to find the piece again after an edit. */
  rekeyToken: unknown;
}

export interface SegmentBadge {
  icon: ReactNode;
  tone: string;
  label: string;
  title: string;
}

export interface SegmentProvider<O extends SegmentOptionLike = SegmentOptionLike, E extends SegmentEvaluationLike = SegmentEvaluationLike> {
  domain: SegmentDomain;
  /** Prefix of the card's test ids ("duct-segment" gives duct-segment-card, duct-segment-peek, ...). */
  testIdPrefix: string;
  /** The piece in focus, or null when it is gone. Cheap when called again with the same drawing. */
  model: (scene: HvacElement[], focus: SegmentFocus) => SegmentCardModel<O, E> | null;
  /** Badges per option (ids into `badges`). */
  rank?: (options: readonly O[], evaluations: ReadonlyMap<string, E>) => Map<string, string[]>;
  badges?: Readonly<Record<string, SegmentBadge>>;
  /** The badge that puts an option first among a peek's quick picks. */
  recommendedBadge?: string;
  /** A row's picture. */
  optionGlyph: (option: O) => ReactNode;
  /** A row's change, as chips. */
  chips: (evaluation: E) => ReactNode;
  /** An evaluation's one-line result. */
  result: (evaluation: E) => ReactNode;
  /** Order of a peek's quick picks after the recommended one (lower first). */
  quickScore?: (evaluation: E) => number;
  /** Apply: one undo step. */
  commit: (evaluation: E, option: O) => void;
  /**
   * The piece to show once an applied option has changed the run: the same key
   * when it still exists, else what the token points to, else null (close).
   */
  rekey: (scene: HvacElement[], focus: SegmentFocus, token: unknown) => SegmentFocus | null;
}
