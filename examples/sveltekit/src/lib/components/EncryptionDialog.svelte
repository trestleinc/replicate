<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { encryptionStore, type PendingAction } from "$lib/encryption";

  let passphrase = $state("");
  let recoveryKey = $state("");
  let loading = $state(false);
  let error = $state<string | null>(null);

  const pendingAction = encryptionStore.pendingAction;

  function getDialogTitle(action: PendingAction): string {
    switch (action.type) {
      case "passphrase-setup": return "Create Backup Passphrase";
      case "passphrase-get": return "Enter Passphrase";
      case "recovery-show": return "Save Your Recovery Key";
      case "recovery-get": return "Enter Recovery Key";
      default: return "";
    }
  }

  function getDialogDescription(action: PendingAction): string {
    switch (action.type) {
      case "passphrase-setup":
        return "Create a backup passphrase in case WebAuthn isn't available.";
      case "passphrase-get":
        return "Enter your passphrase to unlock your encrypted data.";
      case "recovery-show":
        return "This is your only way to recover your data. Save it somewhere safe!";
      case "recovery-get":
        return "Enter your recovery key to restore access to your data.";
      default: return "";
    }
  }

  function handleSubmit(e: Event) {
    e.preventDefault();
    error = null;
    loading = true;

    try {
      const action = $pendingAction;
      if (action.type === "passphrase-setup" || action.type === "passphrase-get") {
        if (passphrase.length < 8) {
          error = "Passphrase must be at least 8 characters";
          loading = false;
          return;
        }
        encryptionStore.submitPassphrase(passphrase);
        passphrase = "";
      }
      else if (action.type === "recovery-get") {
        if (!recoveryKey.trim()) {
          error = "Please enter your recovery key";
          loading = false;
          return;
        }
        encryptionStore.submitRecoveryKey(recoveryKey.trim());
        recoveryKey = "";
      }
    }
    finally {
      loading = false;
    }
  }

  function handleCancel() {
    const action = $pendingAction;
    if (action.type === "passphrase-setup" || action.type === "passphrase-get") {
      encryptionStore.cancelPassphrase();
    }
    else if (action.type === "recovery-get") {
      encryptionStore.cancelRecovery();
    }
    passphrase = "";
    recoveryKey = "";
    error = null;
  }

  function handleAcknowledge() {
    encryptionStore.acknowledgeRecoveryKey();
  }

  $effect(() => {
    if ($pendingAction.type === "none") {
      passphrase = "";
      recoveryKey = "";
      error = null;
      loading = false;
    }
  });

  function getPlaceholder(type: string): string {
    return type === "passphrase-setup"
      ? "Create passphrase (min 8 characters)"
      : "Enter passphrase";
  }
</script>

<Dialog.Root
  open={$pendingAction.type !== "none"}
  onOpenChange={(open) => { if (!open) handleCancel(); }}
>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>{getDialogTitle($pendingAction)}</Dialog.Title>
      <Dialog.Description>{getDialogDescription($pendingAction)}</Dialog.Description>
    </Dialog.Header>

    {#if $pendingAction.type === "recovery-show"}
      <div class="py-4">
        <div
          class="bg-muted p-4 rounded-lg font-mono text-center text-lg
                 tracking-wider select-all"
        >
          {$pendingAction.recoveryKey}
        </div>
        <p class="text-sm text-muted-foreground mt-3 text-center">
          Write this down or save it in a password manager.
        </p>
      </div>
      <Dialog.Footer>
        <Button onclick={handleAcknowledge} class="w-full">
          I've Saved My Recovery Key
        </Button>
      </Dialog.Footer>
    {:else}
      <form onsubmit={handleSubmit} class="flex flex-col gap-4 py-4">
        {#if $pendingAction.type === "passphrase-setup"
        || $pendingAction.type === "passphrase-get"}
          <Input
            type="password"
            bind:value={passphrase}
            placeholder={getPlaceholder($pendingAction.type)}
            required
            minlength={8}
            disabled={loading}
            autofocus
          />
        {:else if $pendingAction.type === "recovery-get"}
          <Input
            bind:value={recoveryKey}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
            required
            disabled={loading}
            autofocus
            class="font-mono tracking-wider"
          />
        {/if}

        {#if error}
          <p class="text-sm text-destructive">{error}</p>
        {/if}

        <div class="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onclick={handleCancel}
            disabled={loading}
            class="flex-1"
          >
            Cancel
          </Button>
          <Button type="submit" disabled={loading} class="flex-1">
            {loading ? "..." : "Continue"}
          </Button>
        </div>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
