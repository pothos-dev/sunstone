// The codebase's standard retry-until-ready pattern: schedule `fn` on the next
// animation frame and keep retrying across frames until it reports done or the
// retry budget runs out. Used for focusing DOM that a reactive re-render is
// still building (Tile views, Explorer rows, transiently revealed Regions).

/**
 * Run `fn` on the next animation frame; while it returns `false`, retry on
 * subsequent frames up to `maxRetries` more times (so `fn` runs at most
 * `maxRetries + 1` times). `fn` returns `true` to stop — whether it succeeded
 * or decided the retry is moot.
 */
export function retryFrames(fn: () => boolean, maxRetries: number): void {
  let tries = 0;
  const attempt = () => {
    if (fn()) return;
    if (tries++ < maxRetries) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
