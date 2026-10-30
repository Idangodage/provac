/**
 * How far a task handed off by Auto route has got, reported from wherever it
 * runs: a worker posts it to the run, the inline runner passes it straight on.
 * It only feeds the progress shown; nothing is decided by it.
 */
export interface TaskProgress {
  completed: number;
  total: number;
}

let reporter: ((progress: TaskProgress) => void) | null = null;

/** A task says how far it has got (to whoever is listening, if anyone). */
export function reportTaskProgress(progress: TaskProgress): void {
  reporter?.(progress);
}

/** Who hears the running task's progress; returns who did before. */
export function setTaskProgressReporter(next: ((progress: TaskProgress) => void) | null): ((progress: TaskProgress) => void) | null {
  const previous = reporter;
  reporter = next;
  return previous;
}
