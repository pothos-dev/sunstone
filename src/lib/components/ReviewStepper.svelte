<script lang="ts">
  /**
   * The review-mode history stepper bar: `← older` / `newer →`
   * walk the commit pairs of the active Concept's file history, and the middle
   * shows the comparison label plus the newer side's commit. Pure display over
   * a `ReviewStep` (see `$lib/editor/reviewStepper`); the Tile owns the state.
   */
  import type { ReviewStep } from '$lib/editor/reviewStepper';

  interface Props {
    stepInfo: ReviewStep;
    /** Step the comparison: `+1` one pair older, `-1` one pair newer. */
    onStep: (delta: number) => void;
  }

  let { stepInfo, onStep }: Props = $props();
</script>

<div class="review-stepper" data-testid="review-stepper">
  <button
    type="button"
    class="nav-btn"
    data-testid="review-older"
    title="Compare the previous (older) commit pair"
    aria-label="Older change"
    disabled={!stepInfo.canOlder}
    onclick={() => onStep(1)}>← older</button
  >
  <div class="review-stepper-meta">
    <span class="review-comparison" data-testid="review-stepper-label">{stepInfo.label}</span>
    {#if stepInfo.newer}
      <span class="review-hash" data-testid="review-stepper-hash">{stepInfo.newer.hash}</span>
      <span class="review-subject" data-testid="review-stepper-subject">{stepInfo.newer.subject}</span>
      <span class="review-date" data-testid="review-stepper-date">{stepInfo.newer.relativeDate}</span>
    {/if}
  </div>
  <button
    type="button"
    class="nav-btn"
    data-testid="review-newer"
    title="Compare the next (newer) commit pair"
    aria-label="Newer change"
    disabled={!stepInfo.canNewer}
    onclick={() => onStep(-1)}>newer →</button
  >
</div>

<style>
  .review-stepper {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: none;
    padding: 0.35rem 0.75rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elevated);
    font-size: 0.8rem;
  }

  .review-stepper-meta {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    justify-content: center;
    overflow: hidden;
    white-space: nowrap;
  }

  .review-comparison {
    font-weight: 600;
    color: var(--text);
  }

  .review-hash {
    font-family: var(--font-mono, ui-monospace, monospace);
    color: var(--accent);
  }

  .review-subject {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .review-date {
    color: var(--text-muted);
    flex: none;
  }

  .review-stepper .nav-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    height: 1.7rem;
    padding: 0 0.55rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    font: inherit;
    font-size: 0.78rem;
    line-height: 1;
    cursor: pointer;
    transition: background 0.12s ease;
  }

  .review-stepper .nav-btn:hover:not(:disabled) {
    background: var(--hover);
  }

  .review-stepper .nav-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
</style>
