<script lang="ts">
  // Signed-in identity affordance for the web App shell, living in the activity
  // rail's bottom user slot (mirrors the anon surface's sign-in button). Renders
  // a round avatar button — the OIDC `picture` if the provider gave one, else
  // the user's initials — that opens a small popover with the display name and a
  // Sign out button. Presentational: sign-out is delegated to the parent (the
  // island owns the Auth.js round-trip).
  import type { WebUser } from './loadConcept';

  interface Props {
    /** The signed-in identity (display name + optional avatar image URL). */
    user: WebUser;
    /** Sign out (delegated to the parent's Auth.js client round-trip). */
    onSignOut: () => void;
  }

  let { user, onSignOut }: Props = $props();

  let open = $state(false);
  let root = $state<HTMLElement | null>(null);

  // Up to two initials from the display name (e.g. "Ada Lovelace" → "AL").
  const initials = $derived(
    user.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '?',
  );

  function toggle() {
    open = !open;
  }

  // Close on outside-click / Escape while the popover is open.
  $effect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (root && !root.contains(e.target as Node)) open = false;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') open = false;
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  });
</script>

<div class="user-menu" bind:this={root}>
  <button
    type="button"
    class="avatar-btn"
    data-testid="user-menu"
    title={user.name}
    aria-label="Account"
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={toggle}
  >
    {#if user.image}
      <img class="avatar-img" src={user.image} alt="" referrerpolicy="no-referrer" />
    {:else}
      <span class="avatar-initials" aria-hidden="true">{initials}</span>
    {/if}
  </button>

  {#if open}
    <div class="popover" role="menu" aria-label="Account">
      <span class="popover-name" data-testid="web-user" title={user.name}>{user.name}</span>
      <button
        type="button"
        class="popover-btn"
        role="menuitem"
        data-testid="web-sign-out"
        onclick={() => {
          open = false;
          onSignOut();
        }}>Sign out</button
      >
    </div>
  {/if}
</div>

<style>
  .user-menu {
    position: relative;
    width: 2rem;
    height: 2rem;
  }

  .avatar-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--accent, #d9622b);
    color: #fff;
    font: inherit;
    font-size: 0.72rem;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    overflow: hidden;
    opacity: 0.9;
    transition: opacity 0.12s ease, box-shadow 0.12s ease;
  }

  .avatar-btn:hover {
    opacity: 1;
  }

  .avatar-btn:focus-visible {
    outline: 2px solid var(--accent-ring, var(--accent, #d9622b));
    outline-offset: 2px;
    opacity: 1;
  }

  .avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  /* Anchored above the avatar (the rail's user slot sits at the bottom-left) and
     opening rightward off the narrow rail. */
  .popover {
    position: absolute;
    bottom: 0;
    left: calc(100% + 0.5rem);
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    min-width: 10rem;
    padding: 0.6rem;
    border: 1px solid var(--border, #ccc);
    border-radius: var(--radius-sm, 6px);
    background: var(--bg-elevated, #f0f2f6);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  }

  .popover-name {
    max-width: 14rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text, inherit);
  }

  .popover-btn {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--border, #ccc);
    border-radius: var(--radius-sm, 6px);
    background: var(--bg, #fff);
    color: inherit;
    font: inherit;
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s ease;
  }

  .popover-btn:hover {
    background: var(--hover, rgba(127, 127, 127, 0.15));
  }
</style>
