<script lang="ts">
  // PROTOTYPE — settings page, three layouts on one overlay. Throwaway.
  //
  // "Three variants of the settings page, switchable via `?settings=A|B|C`,
  // opened from the rail's gear or Ctrl/Cmd+,". The `config.json` drawer and
  // the bottom switcher are prototype instruments, not part of the design.
  import { replaceState } from '$app/navigation';
  import { useOverlay } from '$lib/state/overlay.svelte';
  import { focus } from '$lib/state/focus.svelte';
  import { draft } from './draft.svelte';
  import ConfigDrawer from './ConfigDrawer.svelte';
  import PrototypeSwitcher from './PrototypeSwitcher.svelte';
  import VariantA from './VariantA.svelte';
  import VariantB from './VariantB.svelte';
  import VariantC from './VariantC.svelte';

  interface Props {
    open: boolean;
    onclose: () => void;
  }
  let { open, onclose }: Props = $props();

  const VARIANTS = [
    { key: 'A', name: 'Dialog with sidebar' },
    { key: 'B', name: 'Full page, one scroll' },
    { key: 'C', name: 'Searchable palette' },
  ];

  function readVariant(): string {
    const v = new URL(location.href).searchParams.get('settings');
    return VARIANTS.some((x) => x.key === v) ? (v as string) : 'A';
  }

  let variant = $state(typeof location === 'undefined' ? 'A' : readVariant());

  useOverlay(
    () => open,
    () => onclose(),
  );

  $effect(() => {
    if (open) void draft.load();
  });

  // Keep `?settings=` in step so a reload reopens the same variant.
  $effect(() => {
    const url = new URL(location.href);
    if (open) url.searchParams.set('settings', variant);
    else url.searchParams.delete('settings');
    if (url.href !== location.href) replaceState(url, {});
  });

  function close() {
    focus.cancelTopOverlay();
  }

  // App ignores keys from inside the overlay, so whatever a variant did not
  // handle (and stop) lands here: Escape and Ctrl/Cmd+, close.
  function onKeydown(e: KeyboardEvent) {
    const plainEscape = e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    const toggle = e.key === ',' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
    if ((plainEscape && !e.defaultPrevented) || toggle) {
      e.preventDefault();
      close();
    }
  }
</script>

{#if open}
  <!-- focusout stops here: the app's Region tracker has nothing to track inside
       settings, and a subpage swap that drops the focused node would otherwise
       write focus state mid-render. -->
  <div
    class="proto-root"
    data-settings-proto
    role="presentation"
    onkeydown={onKeydown}
    onfocusout={(e) => e.stopPropagation()}
  >
    {#if variant === 'A'}
      <VariantA onclose={close} />
    {:else if variant === 'B'}
      <VariantB onclose={close} />
    {:else}
      <VariantC onclose={close} />
    {/if}
  </div>
  <ConfigDrawer />
  {#if import.meta.env.DEV}
    <PrototypeSwitcher variants={VARIANTS} bind:current={variant} />
  {/if}
{/if}

<style>
  .proto-root {
    display: contents;
  }
</style>
