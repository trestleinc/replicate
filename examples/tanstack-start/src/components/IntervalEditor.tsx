import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import Placeholder from "@tiptap/extension-placeholder";
import { Effect, Fiber } from "effect";
import { useEffect, useState, useRef } from "react";
import type { EditorBinding } from "@trestleinc/replicate/client";

import {
	Status,
	Priority,
	StatusLabels,
	PriorityLabels,
	type StatusValue,
	type PriorityValue,
} from "../types/interval";
import type { Interval } from "../types/interval";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import {
	DropdownMenu,
	DropdownMenuTrigger,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
} from "./ui/dropdown-menu";

interface IntervalEditorProps {
	intervalId: string;
	collection: {
		utils: {
			prose(document: string, field: "description"): Promise<EditorBinding>;
		};
		update(id: string, updater: (draft: Interval) => void): void;
	};
	interval: Interval;
	onPropertyUpdate?: (updates: Partial<Pick<Interval, "status" | "priority">>) => void;
}

export function IntervalEditor({
	intervalId,
	collection,
	interval,
	onPropertyUpdate,
}: IntervalEditorProps) {
	const [binding, setBinding] = useState<EditorBinding | null>(null);
	const [error, setError] = useState<Error | null>(null);

	// Get editor binding using Effect-TS for proper cancellation
	useEffect(() => {
		// Reset state immediately on interval change
		setBinding(null);
		setError(null);

		// Create an interruptible effect for fetching the binding
		const fetchBinding = Effect.tryPromise({
			try: () => collection.utils.prose(intervalId, "description"),
			catch: e => e as Error,
		});

		// Fork the effect to get a fiber we can interrupt
		const fiber = Effect.runFork(fetchBinding);

		// Handle the result when the fiber completes
		Fiber.join(fiber)
			.pipe(
				Effect.tap(result => Effect.sync(() => setBinding(result))),
				Effect.catchAll(err => Effect.sync(() => setError(err))),
				Effect.runPromise,
			)
			.catch(() => {
				// Silently ignore interruption - expected when switching intervals
			});

		return () => {
			Effect.runFork(Fiber.interrupt(fiber));
			binding?.destroy();
		};
	}, [collection, intervalId]);

	if (error) {
		return (
			<div className="editor-loading" aria-live="polite">
				<p className="text-error">
					Failed to load editor:
					{error.message}
				</p>
			</div>
		);
	}

	if (!binding) {
		return (
			<div className="editor-loading" aria-live="polite" aria-busy="true">
				<div className="editor-loading-spinner" />
				<p>Loading editor...</p>
			</div>
		);
	}

	return (
		<IntervalEditorView
			key={intervalId}
			binding={binding}
			interval={interval}
			collection={collection}
			intervalId={intervalId}
			onPropertyUpdate={onPropertyUpdate}
		/>
	);
}

interface IntervalEditorViewProps {
	binding: EditorBinding;
	interval: Interval;
	collection: {
		update(id: string, updater: (draft: Interval) => void): void;
	};
	intervalId: string;
	onPropertyUpdate?: (updates: Partial<Pick<Interval, "status" | "priority">>) => void;
}

function IntervalEditorView({
	binding,
	interval,
	collection,
	intervalId,
	onPropertyUpdate,
}: IntervalEditorViewProps) {
	const [title, setTitle] = useState(interval.title);
	const [isEditingTitle, setIsEditingTitle] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const editor = useEditor(
		{
			extensions: [
				StarterKit.configure({
					undoRedo: false,
				}),
				Collaboration.configure({
					fragment: binding.fragment,
				}),
				CollaborationCaret.configure({
					provider: binding.provider,
				}),
				Placeholder.configure({
					placeholder: "Write your essay here...",
				}),
			],
			editorProps: {
				attributes: {
					class: "tiptap-editor interval-essay",
				},
			},
		},
		[binding.fragment, binding.provider],
	);

	useEffect(() => {
		if (!isEditingTitle) {
			setTitle(interval.title);
		}
	}, [interval.title, isEditingTitle]);

	useEffect(() => {
		if (isEditingTitle) {
			inputRef.current?.focus();
		}
	}, [isEditingTitle]);

	const handleTitleChange = (newTitle: string) => {
		setTitle(newTitle);
	};

	const handleTitleBlur = () => {
		setIsEditingTitle(false);
		if (title.trim() !== interval.title) {
			collection.update(intervalId, (draft: Interval) => {
				draft.title = title.trim() || "Untitled";
				draft.updatedAt = Date.now();
			});
		}
	};

	const handleTitleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			(e.target as HTMLInputElement).blur();
		}
	};

	const statusOptions = Object.values(Status) as StatusValue[];
	const priorityOptions = Object.values(Priority) as PriorityValue[];

	return (
		<div className="max-w-[680px] mx-auto px-8 py-12 w-full">
			{/* Title */}
			{isEditingTitle ? (
				<input
					ref={inputRef}
					type="text"
					value={title}
					onChange={e => handleTitleChange(e.target.value)}
					onBlur={handleTitleBlur}
					onKeyDown={handleTitleKeyDown}
					className="w-full font-display text-3xl font-normal text-foreground bg-transparent border-none border-b-2 border-primary p-0 pb-1 leading-tight outline-none"
				/>
			) : (
				<button
					type="button"
					className="w-full font-display text-3xl font-normal text-foreground leading-tight cursor-text transition-colors hover:text-primary text-left bg-transparent border-none p-0"
					onClick={() => setIsEditingTitle(true)}
				>
					{title || "Untitled"}
				</button>
			)}

			{/* Properties row - always visible */}
			{onPropertyUpdate && (
				<div className="flex items-center gap-4 mt-4 mb-8 pb-6 border-b border-border text-sm">
					<DropdownMenu>
						<DropdownMenuTrigger className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-muted transition-colors">
							<StatusIcon status={interval.status} size={14} />
							<span>{StatusLabels[interval.status]}</span>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							<DropdownMenuRadioGroup
								value={interval.status}
								onValueChange={v => onPropertyUpdate({ status: v as StatusValue })}
							>
								{statusOptions.map(status => (
									<DropdownMenuRadioItem key={status} value={status}>
										<StatusIcon status={status} size={14} />
										{StatusLabels[status]}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>

					<DropdownMenu>
						<DropdownMenuTrigger className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-muted transition-colors">
							<PriorityIcon priority={interval.priority} size={14} />
							<span>{PriorityLabels[interval.priority]}</span>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start">
							<DropdownMenuRadioGroup
								value={interval.priority}
								onValueChange={v => onPropertyUpdate({ priority: v as PriorityValue })}
							>
								{priorityOptions.map(priority => (
									<DropdownMenuRadioItem key={priority} value={priority}>
										<PriorityIcon priority={priority} size={14} />
										{PriorityLabels[priority]}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			)}

			<div className="min-h-[200px]">
				<EditorContent editor={editor} />
			</div>
		</div>
	);
}
