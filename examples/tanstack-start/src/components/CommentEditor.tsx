import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import Placeholder from "@tiptap/extension-placeholder";
import { Effect, Fiber } from "effect";
import { useEffect, useState, useMemo } from "react";
import type { EditorBinding } from "@trestleinc/replicate/client";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";

const DEFAULT_COLORS = [
  "#F87171",
  "#FB923C",
  "#FBBF24",
  "#A3E635",
  "#34D399",
  "#22D3EE",
  "#60A5FA",
  "#A78BFA",
  "#F472B6",
];

function getRandomColor(): string {
  return DEFAULT_COLORS[Math.floor(Math.random() * DEFAULT_COLORS.length)];
}

function getRandomName(): string {
  const adjectives = ["Swift", "Bright", "Calm", "Bold", "Keen"];
  const nouns = ["Fox", "Owl", "Bear", "Wolf", "Hawk"];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj} ${noun}`;
}

interface CommentEditorProps {
  commentId: string;
  collection: {
    utils: {
      prose(document: string, field: "body"): Promise<EditorBinding>;
    };
  };
}

export function CommentEditor({ commentId, collection }: CommentEditorProps) {
  const [binding, setBinding] = useState<EditorBinding | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    setBinding(null);
    setError(null);

    const fetchBinding = Effect.tryPromise({
      try: () => collection.utils.prose(commentId, "body"),
      catch: e => e as Error,
    });

    const fiber = Effect.runFork(fetchBinding);

    Fiber.join(fiber)
      .pipe(
        Effect.tap(result => Effect.sync(() => setBinding(result))),
        Effect.catchAll(err => Effect.sync(() => setError(err))),
        Effect.runPromise,
      )
      .catch(() => {
        // Silently ignore interruption
      });

    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [collection, commentId]);

  if (error) {
    return <p className="text-sm text-destructive">Failed to load comment</p>;
  }

  if (!binding) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  return <CommentEditorView key={commentId} binding={binding} />;
}

function CommentEditorView({ binding }: { binding: EditorBinding }) {
  // Stable user identity for collaboration cursors
  const user = useMemo(() => ({
    name: getRandomName(),
    color: getRandomColor(),
  }), []);

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
          user,
        }),
        Placeholder.configure({
          placeholder: "Write a comment...",
        }),
      ],
      editorProps: {
        attributes: {
          class: "tiptap-editor comment-editor prose text-sm outline-none",
        },
      },
    },
    [binding.fragment, binding.provider],
  );

  return <EditorContent editor={editor} />;
}

// Simple text input for creating new comments
interface NewCommentInputProps {
  onSubmit: (text: string) => void;
}

export function NewCommentInput({ onSubmit }: NewCommentInputProps) {
  const [text, setText] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim()) {
      onSubmit(text.trim());
      setText("");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex items-end gap-2">
      <Textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Add a comment..."
        className="min-h-0 resize-none text-sm"
      />
      <Button type="submit" size="sm" disabled={!text.trim()}>
        Post
      </Button>
    </form>
  );
}
