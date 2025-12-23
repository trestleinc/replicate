import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import Placeholder from "@tiptap/extension-placeholder";
import { Effect, Fiber } from "effect";
import { useEffect, useState } from "react";
import type { EditorBinding } from "@trestleinc/replicate/client";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";

interface CommentEditorProps {
  commentId: string;
  collection: {
    utils: {
      prose(documentId: string, field: "body"): Promise<EditorBinding>;
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
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          undoRedo: false,
        }),
        Collaboration.configure({
          fragment: binding.fragment,
        }),
        Placeholder.configure({
          placeholder: "Write a comment...",
        }),
      ],
      editorProps: {
        attributes: {
          class: "tiptap-editor prose text-sm outline-none min-h-[1.5em]",
        },
      },
    },
    [binding.fragment],
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
    <form onSubmit={handleSubmit} className="mt-6 space-y-3">
      <Textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Write a comment..."
        rows={3}
      />
      <Button type="submit" disabled={!text.trim()}>
        Comment
      </Button>
    </form>
  );
}
