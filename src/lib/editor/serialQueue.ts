// A one-at-a-time call queue for diagram engines that keep shared state per
// instance: `@terrastruct/d2` (one pending resolve/reject per `D2`) and
// `@plantuml/core` (one shared render slot per page). Two overlapping calls
// would cross their results; every call goes through here instead.

/**
 * A one-at-a-time queue. Tasks run in the order they were queued, each after
 * the previous one settles. A failed task does not stall the ones behind it.
 */
export function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}
