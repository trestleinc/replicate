<script module lang="ts">
	import { Status, Priority, StatusLabels, PriorityLabels } from '$lib/types';
	import type { StatusValue, PriorityValue } from '$lib/types';

	// PERFORMANCE: Static arrays at module scope - shared across all instances
	const statusOptions = Object.values(Status) as StatusValue[];
	const priorityOptions = Object.values(Priority) as PriorityValue[];

	// Visibility labels
	const VisibilityLabels = {
		public: 'Public',
		private: 'Private',
	} as const;
</script>

<script lang="ts">
	import { browser } from '$app/environment';
	import type { Editor } from '@tiptap/core';
	import type { EditorBinding, CounterBinding, SetBinding, RegisterBinding } from '@trestleinc/replicate/client';
	import { getIntervalsContext } from '$lib/contexts/intervals.svelte';
	import type { Interval } from '$collections/useIntervals';
	import StatusIcon from './StatusIcon.svelte';
	import PriorityIcon from './PriorityIcon.svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Avatar from '$lib/components/ui/avatar';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Globe, Lock, X } from '@lucide/svelte';
	import { getAuthClient } from '$lib/auth-client';

	interface Props {
		intervalId: string;
		interval: Interval;
		showProperties?: boolean;
	}

	let { intervalId, interval, showProperties = false }: Props = $props();

	// Auth state for ownership check
	let sessionData = $state<{ user?: { id: string } } | null>(null);

	$effect(() => {
		const authClient = getAuthClient();
		const session = authClient.useSession();
		const unsubscribe = session.subscribe((s) => {
			sessionData = s.data;
		});
		return unsubscribe;
	});

	// Check if current user owns this interval
	const isOwner = $derived(
		sessionData?.user?.id != null && sessionData.user.id === interval.ownerId
	);

	// Get collection from context for mutations
	const intervalsCtx = getIntervalsContext();

	// Use $state.raw for DOM refs (no deep reactivity needed)
	let editorElement = $state<HTMLDivElement | null>(null);
	let editor = $state<Editor | null>(null);
	let binding = $state<EditorBinding | null>(null);
	let counter = $state<CounterBinding | null>(null);
	let viewCount = $state<number>(0);
	let error = $state<string | null>(null);
	let isLoading = $state(true);

	// Remote users from awareness
	interface RemoteUser {
		clientId: number;
		name: string;
		color: string;
		avatar?: string;
	}
	let remoteUsers = $state<RemoteUser[]>([]);

	let isEditingTitle = $state(false);
	let editingTitle = $state('');
	let titleInputRef = $state<HTMLInputElement | null>(null);

	// Tags state
	let newTagInput = $state('');
	let tagsBinding = $state<SetBinding<string> | null>(null);
	let tags = $state<string[]>([]);

	// Status and Priority bindings (CRDT registers)
	let statusBinding = $state<RegisterBinding<StatusValue> | null>(null);
	let priorityBinding = $state<RegisterBinding<PriorityValue> | null>(null);
	let status = $state<StatusValue>(interval.status as StatusValue);
	let priority = $state<PriorityValue>(interval.priority as PriorityValue);

	const title = $derived(isEditingTitle ? editingTitle : interval.title);

	$effect(() => {
		if (isEditingTitle) {
			titleInputRef?.focus();
		}
	});


	function addTag(tag: string) {
		const normalized = tag.trim().toLowerCase();
		if (!normalized || tags.includes(normalized)) return;

		tagsBinding?.add(normalized);
		newTagInput = '';
	}

	function removeTag(tag: string) {
		tagsBinding?.remove(tag);
	}

	function handleTagKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			addTag(newTagInput);
		}
	}

	// Subscribe to awareness changes for remote user avatars
	$effect(() => {
		const awareness = binding?.provider?.awareness;
		if (!awareness) return;

		const updateRemoteUsers = () => {
			const states = awareness.getStates();
			const localClientId = awareness.clientID;
			const users: RemoteUser[] = [];

			states.forEach((state, clientId) => {
				if (clientId !== localClientId && state.user) {
					users.push({
						clientId,
						name: state.user.name ?? 'Anonymous',
						color: state.user.color ?? '#6366f1',
						avatar: state.user.avatar,
					});
				}
			});

			remoteUsers = users;
		};

		awareness.on('update', updateRemoteUsers);
		updateRemoteUsers();

		return () => {
			awareness.off('update', updateRemoteUsers);
		};
	});

	// Initialize TipTap editor
	$effect(() => {
		if (browser && binding && editorElement && !editor) {
			void Promise.all([
				import('@tiptap/core'),
				import('@tiptap/starter-kit'),
				import('@tiptap/extension-collaboration'),
				import('@tiptap/extension-collaboration-caret'),
				import('@tiptap/extension-placeholder'),
			]).then(
				([
					{ Editor },
					{ default: StarterKit },
					{ default: Collaboration },
					{ default: CollaborationCaret },
					{ default: Placeholder },
				]) => {
					if (!editorElement || !binding) return;

					editor = new Editor({
						element: editorElement,
						extensions: [
							StarterKit.configure({ undoRedo: false }),
							Collaboration.configure({
								fragment: binding.fragment,
							}),
							CollaborationCaret.configure({
								provider: binding.provider,
							}),
							Placeholder.configure({
								placeholder: 'Start writing...',
							}),
						],
						editorProps: {
							attributes: {
								class: 'tiptap-editor prose',
							},
						},
					});
				}
			);
		}
	});

	// Cleanup on interval change
	$effect(() => {
		void intervalId;

		return () => {
			binding?.destroy();
			counter?.destroy();
			if (editor) {
				editor.destroy();
				editor = null;
			}
			binding = null;
			counter = null;
		};
	});

	// Initialize prose binding
	$effect(() => {
		if (!browser) return;

		const initBinding = async () => {
			try {
				isLoading = true;
				error = null;
				// Prose binding syncs rich text via Yjs CRDTs
				// 300ms debounce for accurate cursor position tracking
				binding = await intervalsCtx.collection.utils.prose(intervalId, 'description', {
					debounceMs: 300,
					throttleMs: 300,
				});
				isLoading = false;
			} catch (err) {
				error = err instanceof Error ? err.message : 'Failed to load editor';
				isLoading = false;
			}
		};

		initBinding();
	});

	// Initialize counter binding for page view tracking
	$effect(() => {
		if (!browser) return;

		const initCounter = async () => {
			try {
				counter = await intervalsCtx.collection.utils.counter(intervalId, 'viewCount');
				// Auto-increment view count on page load
				counter.increment(1);
				// Subscribe to view count changes
				counter.subscribe((value) => {
					viewCount = value;
				});
			} catch (err) {
				// Counter errors are non-fatal, just log them
				console.error('Failed to initialize view counter:', err);
			}
		};

		initCounter();

		return () => {
			counter?.destroy();
		};
	});

	// Initialize tags binding for CRDT set
	$effect(() => {
		if (!browser) return;

		const initTags = async () => {
			try {
				tagsBinding = await intervalsCtx.collection.utils.set<string>(intervalId, 'tags', {
					serialize: (item) => item,
					deserialize: (key) => key,
				});
				// Subscribe to tag changes
				tagsBinding.subscribe((values) => {
					tags = values;
				});
			} catch (err) {
				console.error('Failed to initialize tags binding:', err);
			}
		};

		initTags();

		return () => {
			tagsBinding?.destroy();
			tagsBinding = null;
		};
	});

	// Initialize status binding for CRDT register
	$effect(() => {
		if (!browser) return;

		const initStatus = async () => {
			try {
				statusBinding = await intervalsCtx.collection.utils.register<StatusValue>(
					intervalId,
					'status'
				);
				// Subscribe to status changes
				statusBinding.subscribe((value) => {
					status = value;
				});
			} catch (err) {
				console.error('Failed to initialize status binding:', err);
			}
		};

		initStatus();

		return () => {
			statusBinding?.destroy();
			statusBinding = null;
		};
	});

	// Initialize priority binding for CRDT register
	$effect(() => {
		if (!browser) return;

		const initPriority = async () => {
			try {
				priorityBinding = await intervalsCtx.collection.utils.register<PriorityValue>(
					intervalId,
					'priority'
				);
				// Subscribe to priority changes
				priorityBinding.subscribe((value) => {
					priority = value;
				});
			} catch (err) {
				console.error('Failed to initialize priority binding:', err);
			}
		};

		initPriority();

		return () => {
			priorityBinding?.destroy();
			priorityBinding = null;
		};
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
			intervalsCtx.collection.update(interval.id, (draft) => {
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
	<div class="editor-container">
		{#if isEditingTitle}
			<input
				bind:this={titleInputRef}
				type="text"
				value={editingTitle}
				oninput={(e) => handleTitleChange(e.currentTarget.value)}
				onblur={handleTitleBlur}
				onkeydown={handleTitleKeyDown}
				class="text-foreground border-primary w-full border-b-2 border-none bg-transparent p-0 pb-1 font-sans text-2xl leading-tight font-medium outline-none"
			/>
		{:else}
			<button
				type="button"
				class="text-foreground transition-fast hover:text-primary w-full cursor-text border-none bg-transparent p-0 text-left font-sans text-2xl leading-tight font-medium"
				onclick={startEditing}
			>
				{title || 'Untitled'}
			</button>
		{/if}

		{#if showProperties}
			<div
				class="border-border mt-4 mb-6 flex items-center justify-between gap-4 border-b pb-4 text-sm"
			>
				<div class="flex items-center gap-3">
					<DropdownMenu.Root>
						<DropdownMenu.Trigger
							class="hover:bg-muted transition-fast flex items-center gap-2 px-2 py-1"
						>
							<StatusIcon {status} size={14} />
							<span class="text-sm">{StatusLabels[status]}</span>
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="start">
							<DropdownMenu.RadioGroup
								value={status}
								onValueChange={(v) => statusBinding?.set(v as StatusValue)}
							>
								{#each statusOptions as statusOption (statusOption)}
									<DropdownMenu.RadioItem value={statusOption}>
										<StatusIcon status={statusOption} size={14} />
										<span class="ml-2">{StatusLabels[statusOption]}</span>
									</DropdownMenu.RadioItem>
								{/each}
							</DropdownMenu.RadioGroup>
						</DropdownMenu.Content>
					</DropdownMenu.Root>

					<DropdownMenu.Root>
						<DropdownMenu.Trigger
							class="hover:bg-muted transition-fast flex items-center gap-2 px-2 py-1"
						>
							<PriorityIcon {priority} size={14} />
							<span class="text-sm">{PriorityLabels[priority]}</span>
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="start">
							<DropdownMenu.RadioGroup
								value={priority}
								onValueChange={(v) => priorityBinding?.set(v as PriorityValue)}
							>
								{#each priorityOptions as priorityOption (priorityOption)}
									<DropdownMenu.RadioItem value={priorityOption}>
										<PriorityIcon priority={priorityOption} size={14} />
										<span class="ml-2">{PriorityLabels[priorityOption]}</span>
									</DropdownMenu.RadioItem>
								{/each}
							</DropdownMenu.RadioGroup>
						</DropdownMenu.Content>
					</DropdownMenu.Root>

					{#if isOwner}
						<div class="bg-border mx-2 h-4 w-px"></div>
						<button
							type="button"
							class="hover:bg-muted transition-fast flex items-center gap-2 px-2 py-1"
							onclick={() => {
								intervalsCtx.collection.update(interval.id, (draft) => {
									draft.isPublic = !draft.isPublic;
									draft.updatedAt = Date.now();
								});
							}}
						>
							{#if interval.isPublic}
								<Globe class="text-muted-foreground h-3.5 w-3.5" />
								<span class="text-sm">{VisibilityLabels.public}</span>
							{:else}
								<Lock class="text-muted-foreground h-3.5 w-3.5" />
								<span class="text-sm">{VisibilityLabels.private}</span>
							{/if}
						</button>
					{/if}

					<!-- Tags Section -->
					<div class="bg-border mx-2 h-4 w-px"></div>

					<div class="flex items-center gap-1.5">
						{#each tags as tag (tag)}
							<span
								class="bg-secondary text-secondary-foreground flex items-center gap-1 px-2 py-0.5 text-xs font-medium"
							>
								{tag}
								<button
									type="button"
									class="hover:text-destructive -mr-0.5 p-0.5 transition-fast"
									onclick={() => removeTag(tag)}
									aria-label="Remove {tag} tag"
								>
									<X class="h-3 w-3" />
								</button>
							</span>
						{/each}

						<input
							type="text"
							bind:value={newTagInput}
							onkeydown={handleTagKeyDown}
							placeholder="+ tag"
							class="bg-transparent text-muted-foreground placeholder:text-muted-foreground/50 h-6 w-16 px-1 text-xs outline-none transition-fast focus:w-24"
						/>
					</div>
				</div>

				{#if viewCount > 0}
					<div class="text-muted-foreground text-sm" aria-label="View count">
						{viewCount} view{viewCount === 1 ? '' : 's'}
					</div>
				{/if}

				{#if remoteUsers.length > 0}
					<Tooltip.Provider>
						<div class="flex gap-1.5" aria-label="Active collaborators">
							{#each remoteUsers as user, i (user.clientId)}
								<div class="avatar-presence-enter" style="animation-delay: {i * 50}ms">
									<Tooltip.Root>
										<Tooltip.Trigger>
											<Avatar.Root
												class="ring-border size-7 ring-1 transition-transform hover:scale-105"
											>
												{#if user.avatar}
													<Avatar.Image src={user.avatar} alt={user.name} />
												{/if}
												<Avatar.Fallback
													class="text-xs font-medium text-white"
													style="background-color: {user.color}"
												>
													{user.name.charAt(0).toUpperCase()}
												</Avatar.Fallback>
											</Avatar.Root>
										</Tooltip.Trigger>
										<Tooltip.Content>
											<p>{user.name}</p>
										</Tooltip.Content>
									</Tooltip.Root>
								</div>
							{/each}
						</div>
					</Tooltip.Provider>
				{/if}
			</div>
		{/if}

		<div class="min-h-[200px]">
			<div bind:this={editorElement}></div>
		</div>
	</div>
{/if}
