/**
 * A long synchronous design written as steps: a generator that yields each
 * request for work it can hand off (sizing a batch of trees) and resumes with
 * the answers. Run here, a request is performed on the spot, so the steps are
 * exactly the plain function they replace; run with a task runner, the work
 * goes to the workers while the design waits.
 */

/** Runs the steps here, performing each request with `perform`. */
export function runSteps<Request, Answer, Result>(steps: Generator<Request, Result, Answer>, perform: (request: Request) => Answer): Result {
  let next = steps.next();
  while (!next.done) next = steps.next(perform(next.value));
  return next.value;
}

/** Runs the steps, performing each request with `perform` (asynchronously: on workers). */
export async function runStepsAsync<Request, Answer, Result>(
  steps: Generator<Request, Result, Answer>, perform: (request: Request) => Promise<Answer>,
): Promise<Result> {
  let next = steps.next();
  while (!next.done) next = steps.next(await perform(next.value));
  return next.value;
}

/**
 * The steps of `inner`, each of its stretches run inside `scope` (a context
 * it sets while it runs, e.g. the active duct building), never the caller's
 * code or the work it hands off.
 */
export function* scopedSteps<Request, Answer, Result>(
  scope: <T>(run: () => T) => T, inner: Generator<Request, Result, Answer>,
): Generator<Request, Result, Answer> {
  let next = scope(() => inner.next());
  while (!next.done) {
    const answer: Answer = yield next.value;
    next = scope(() => inner.next(answer));
  }
  return next.value;
}
