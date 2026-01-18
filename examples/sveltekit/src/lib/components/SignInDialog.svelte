<script lang="ts">
  import { getAuthClient } from "$lib/auth-client";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";

  let { open = $bindable(false) } = $props();

  let mode: "signin" | "signup" = $state("signin");
  let email = $state("");
  let password = $state("");
  let name = $state("");
  let error = $state<string | null>(null);
  let loading = $state(false);

  async function handleSubmit(e: Event) {
    e.preventDefault();
    error = null;
    loading = true;

    const authClient = getAuthClient();

    try {
      if (mode === "signup") {
        const result = await authClient.signUp.email({
          email,
          password,
          name,
        });
        if (result.error) {
          error = result.error.message ?? "Sign up failed";
        } else {
          open = false;
          resetForm();
        }
      } else {
        const result = await authClient.signIn.email({
          email,
          password,
        });
        if (result.error) {
          error = result.error.message ?? "Sign in failed";
        } else {
          open = false;
          resetForm();
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Something went wrong";
    } finally {
      loading = false;
    }
  }

  function resetForm() {
    email = "";
    password = "";
    name = "";
    error = null;
    mode = "signin";
  }

  function toggleMode() {
    mode = mode === "signin" ? "signup" : "signin";
    error = null;
  }
</script>

<Dialog.Root bind:open onOpenChange={(o) => { if (!o) resetForm(); }}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>
        {mode === "signin" ? "Sign In" : "Create Account"}
      </Dialog.Title>
      <Dialog.Description>
        {mode === "signin" 
          ? "Sign in to create private intervals" 
          : "Create an account to save private intervals"}
      </Dialog.Description>
    </Dialog.Header>

    <form onsubmit={handleSubmit} class="flex flex-col gap-4 py-4">
      {#if mode === "signup"}
        <Input
          bind:value={name}
          placeholder="Name"
          required
          disabled={loading}
        />
      {/if}

      <Input
        type="email"
        bind:value={email}
        placeholder="Email"
        required
        disabled={loading}
      />

      <Input
        type="password"
        bind:value={password}
        placeholder="Password"
        required
        minlength={8}
        disabled={loading}
      />

      {#if error}
        <p class="text-sm text-destructive">{error}</p>
      {/if}

      <Button type="submit" disabled={loading}>
        {loading ? "Loading..." : (mode === "signin" ? "Sign In" : "Sign Up")}
      </Button>
    </form>

    <Dialog.Footer class="sm:justify-center">
      <p class="text-sm text-muted-foreground">
        {mode === "signin" ? "Don't have an account? " : "Already have an account? "}
        <button
          type="button"
          class="underline hover:text-foreground"
          onclick={toggleMode}
        >
          {mode === "signin" ? "Sign up" : "Sign in"}
        </button>
      </p>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
