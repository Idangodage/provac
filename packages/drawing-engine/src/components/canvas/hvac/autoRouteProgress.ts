/**
 * How far an Auto route run has got and about how long it still takes, for the
 * progress bar. An estimate only, and nothing reads it but the bar: each step
 * is given a share by what it routes, and the time left follows the run's own
 * pace so far, so a slower computer or a harder drawing soon reads truly.
 */
import { wantsDucts, type AutoRouteServices, type AutoRouteStep, type UnifiedAutoRouteProgress } from './unifiedAutoRoute';

/** What the run has to route. */
export interface AutoRouteWork {
  /** Diffusers and grilles. */
  terminals: number;
  /** Indoor units. */
  units: number;
}

/** A step's share, in seconds on the benchmark set's laptop (only the ratios matter once the run's pace is known). */
function stepShare(step: AutoRouteStep, { terminals, units }: AutoRouteWork): number {
  switch (step) {
    case 'ducts': return 0.6 * terminals;
    case 'refrigerant': return 0.27 * units * units;
    case 'condensate': return 0.06 * units * units;
    case 'drainage-first': return 0.33 * units * units;
    default: return 0.1;
  }
}

export interface AutoRouteEstimate {
  /** Share of the run done, 0 to 1; it never goes back, and is not full until the run is over (another layout may be compared). */
  fraction: number;
  /** About how long is left (null: too early to tell). */
  timeLeftMs: number | null;
  /** When this was worked out, to count the time left down between messages (Date.now()). */
  estimatedAt: number;
}

/** The share done before the time left is worth showing. */
const SHOW_TIME_LEFT_FROM = 0.04;
/** As far as the bar goes while the run is under way. */
const MOST_OF_THE_BAR = 0.97;

/** Makes the estimator of one run: call it with each progress message. */
export function autoRouteEstimator(services: AutoRouteServices, work: AutoRouteWork, now: () => number = Date.now): (progress: UnifiedAutoRouteProgress) => AutoRouteEstimate {
  const started = now();
  const planned: AutoRouteStep[] = [
    'turns',
    ...(wantsDucts(services) ? ['ducts' as const] : []),
    ...(services.gas || services.liquid ? ['refrigerant' as const] : []),
    ...(services.condensate ? ['condensate' as const] : []),
    'audit',
  ];
  let fraction = 0;
  /** The furthest it has got, in shares: a step's own count may start again (another start of the network). */
  let reached = 0;
  return (progress) => {
    const { step } = progress;
    // A step that was not planned (the alternative layouts compared) comes after the rest.
    if (step && !planned.includes(step)) planned.push(step);
    const shares = planned.map((entry) => stepShare(entry, work));
    const total = shares.reduce((sum, share) => sum + share, 0);
    const at = step ? planned.indexOf(step) : 0;
    const within = progress.total > 0 ? Math.max(0, Math.min(1, progress.completed / progress.total)) : 0;
    if (step) reached = Math.max(reached, shares.slice(0, at).reduce((sum, share) => sum + share, 0) + shares[at]! * within);
    const share = total > 0 ? reached / total : 0;
    fraction = Math.max(fraction, Math.min(MOST_OF_THE_BAR, share));
    const time = now();
    return {
      fraction,
      timeLeftMs: share >= SHOW_TIME_LEFT_FROM ? ((time - started) * (total - reached)) / reached : null,
      estimatedAt: time,
    };
  };
}

/** The time left as the bar says it: never to more than it can honestly tell. */
export function formatAutoRouteTimeLeft(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 8) return 'a few seconds left';
  if (seconds < 60) return `about ${Math.ceil(seconds / 5) * 5} s left`;
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} min left`;
}
