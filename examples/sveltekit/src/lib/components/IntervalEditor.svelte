<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import type { Editor } from '@tiptap/core';
	import type { EditorBinding } from '@trestleinc/replicate/client';
	import type { Interval } from '$lib/types';
	import { intervals } from '$collections/useIntervals';

	type Props = {
		intervalId: string;
		interval: Interval;
	};

	let { intervalId, interval }: Props = $props();

	const collection = intervals.get();

	let editorElement = $state<HTMLDivElement | null>(null);
	let editor = $state<Editor | null>(null);
	let binding = $state<EditorBinding | null>(null);
	let error = $state<string | null>(null);
	let isLoading = $state(true);

	// Title editing state
	let isEditingTitle = $state(false);
	let editingTitle = $state(''); // Only used while editing
	let titleInputRef = $state<HTMLInputElement | null>(null);

	// Display title: use editingTitle while editing, otherwise from interval
	const title = $derived(isEditingTitle ? editingTitle : interval.title);

	// Focus input when entering edit mode
	$effect(() => {
		if (isEditingTitle) {
			titleInputRef?.focus();
		}
	});

	// Initialize editor when binding is ready (browser only)
	$effect(() => {
		if (browser && binding && editorElement && !editor) {
			// Dynamic import to avoid SSR issues
			Promise.all([
				import('@tiptap/core'),
				import('@tiptap/starter-kit'),
				import('@tiptap/extension-collaboration'),
				import('@tiptap/extension-placeholder')
			]).then(([{ Editor }, { default: StarterKit }, { default: Collaboration }, { default: Placeholder }]) => {
				if (!editorElement || !binding) return;

				editor = new Editor({
					element: editorElement,
					extensions: [
						StarterKit.configure({
							// Disable history - Yjs handles undo/redo via Collaboration
						}),
						Collaboration.configure({
							fragment: binding.fragment
						}),
						Placeholder.configure({
							placeholder: 'Start writing...'
						})
					],
					editorProps: {
						attributes: {
							class: 'tiptap-editor prose'
						}
					}
				});
			});
		}
	});

	// Cleanup on intervalId change or unmount
	$effect(() => {
		// Track intervalId changes
		const currentId = intervalId;

		return () => {
			// Cleanup when intervalId changes
			if (editor) {
				editor.destroy();
				editor = null;
			}
			binding = null;
		};
	});

	onMount(async () => {
		if (!browser) return;

		try {
			isLoading = true;
			error = null;
			binding = await collection.utils.prose(intervalId, 'description');
			isLoading = false;
		} catch (err) {
			console.error('[IntervalEditor] Failed to get prose binding:', err);
			error = err instanceof Error ? err.message : 'Failed to load editor';
			isLoading = false;
		}
	});

	onDestroy(() => {
		if (editor) {
			editor.destroy();
			editor = null;
		}
	});

	function startEditing() {
		editingTitle = interval.title;
		isEditingTitle = true;
	}

	function handleTitleChange(newTitle: string) {
		editingTitle = newTitle;
	}

	function handleTitleBlur() {
		isEditingTitle = false;
		if (editingTitle.trim() !== interval.title) {
			collection.update(interval.id, (draft) => {
				draft.title = editingTitle.trim() || 'Untitled';
				draft.updatedAt = Date.now();
			});
		}
	}

	function handleTitleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			(e.target as HTMLInputElement).blur();
		}
	}
</script>

{#if error}
	<div class="editor-loading" aria-live="polite">
		<p class="text-destructive">Failed to load editor: {error}</p>
	</div>
{:else if isLoading}
	<div class="editor-loading" aria-live="polite" aria-busy="true">
		<div class="editor-loading-spinner"></div>
		<p>Loading editor...</p>
	</div>
{:else}
	<div class="max-w-[680px] mx-auto px-8 py-12 w-full">
		<!-- Header with title -->
		<div class="mb-8 pb-6 border-b border-border">
			{#if isEditingTitle}
				<input
					bind:this={titleInputRef}
					type="text"
					value={editingTitle}
					oninput={(e) => handleTitleChange(e.currentTarget.value)}
					onblur={handleTitleBlur}
					onkeydown={handleTitleKeyDown}
					class="w-full font-display text-3xl font-normal text-foreground bg-transparent border-none border-b-2 border-primary p-0 pb-1 leading-tight outline-none"
				/>
			{:else}
				<button
					type="button"
					class="w-full font-display text-3xl font-normal text-foreground leading-tight cursor-text transition-colors hover:text-primary text-left bg-transparent border-none p-0 pb-1 border-b-2 border-transparent"
					onclick={startEditing}
				>
					{title || 'Untitled'}
				</button>
			{/if}
		</div>

		<!-- Editor content -->
		<div class="min-h-[200px]">
			<div bind:this={editorElement}></div>
		</div>
	</div>
{/if}
