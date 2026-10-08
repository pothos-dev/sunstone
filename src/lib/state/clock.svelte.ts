/**
 * A coarse "now" for display-time derivations (OKF §5.5 staleness): ticks once
 * a minute in the browser, so a Concept left open past its `stale_after` gets
 * marked without a reload. On SSR it is just the render time.
 */
class Clock {
  now = $state<number>(Date.now());

  constructor() {
    if (typeof window !== 'undefined') setInterval(() => (this.now = Date.now()), 60_000);
  }
}

export const clock = new Clock();
