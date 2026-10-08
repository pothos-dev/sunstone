<script lang="ts">
  import { onMount } from 'svelte';
  import { backend } from '$lib/ipc';
  import App from '$lib/App.svelte';
  import Launcher from '$lib/components/Launcher.svelte';
  import ReleaseNotesDialog from '$lib/components/ReleaseNotesDialog.svelte';
  import UpdateNotice from '$lib/components/UpdateNotice.svelte';

  // The desktop (Tauri/fake) entry decides, on startup, between two shells:
  //  - a Bundle is open (launched with a path, or picked in the launcher) → the
  //    full editor `<App/>`;
  //  - no Bundle open (`sunstone` with no path) → the `<Launcher/>`, a list of
  //    known folders to pick from.
  // `backend.currentBundle()` is the single source of truth; picking a folder in
  // the launcher opens it in-process then reloads, so this decision re-runs and
  // lands on `<App/>`.
  let mode = $state<'loading' | 'launcher' | 'app'>('loading');

  onMount(async () => {
    try {
      const current = await backend.currentBundle();
      mode = current === null ? 'launcher' : 'app';
    } catch {
      // A backend that can't answer (shouldn't happen on desktop) falls back to
      // the launcher rather than a blank editor with no Bundle.
      mode = 'launcher';
    }
  });
</script>

{#if mode === 'app'}
  <App />
{:else if mode === 'launcher'}
  <Launcher />
{/if}

<!-- Updates are about the app, not a Bundle: shown over the launcher and the
     editor alike. -->
<UpdateNotice />
<ReleaseNotesDialog />
