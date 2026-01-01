import { useState, useEffect, useCallback, useRef } from "react";
import * as Y from "yjs";
import { intervals } from "@/collections/useIntervals";
import type { Interval } from "@/types/interval";

type ProseContent = Interval["description"];

type YXmlFragment = any;
type YXmlElement = any;
type YXmlText = any;

interface XmlNodeJSON {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: XmlNodeJSON[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

interface XmlFragmentJSON {
  type: "doc";
  content?: XmlNodeJSON[];
}

function fragmentToJSON(fragment: YXmlFragment): XmlFragmentJSON {
  const content: XmlNodeJSON[] = [];

  for (const child of fragment.toArray()) {
    if (child.constructor.name === "YXmlElement") {
      content.push(xmlElementToJSON(child));
    } else if (child.constructor.name === "YXmlText") {
      const textContent = xmlTextToJSON(child);
      if (textContent.length > 0) {
        content.push({
          type: "paragraph",
          content: textContent,
        });
      }
    }
  }

  return {
    type: "doc",
    content: content.length > 0 ? content : [{ type: "paragraph" }],
  };
}

function xmlElementToJSON(element: YXmlElement): XmlNodeJSON {
  const result: XmlNodeJSON = {
    type: element.nodeName,
  };

  const attrs = element.getAttributes();
  if (Object.keys(attrs).length > 0) {
    result.attrs = attrs;
  }

  const content: XmlNodeJSON[] = [];
  for (const child of element.toArray()) {
    if (child.constructor.name === "YXmlElement") {
      content.push(xmlElementToJSON(child));
    } else if (child.constructor.name === "YXmlText") {
      content.push(...xmlTextToJSON(child));
    }
  }

  if (content.length > 0) {
    result.content = content;
  }

  return result;
}

function xmlTextToJSON(text: YXmlText): XmlNodeJSON[] {
  const result: XmlNodeJSON[] = [];
  const delta = text.toDelta();

  for (const op of delta) {
    if (typeof op.insert === "string") {
      const node: XmlNodeJSON = {
        type: "text",
        text: op.insert,
      };

      if (op.attributes && Object.keys(op.attributes).length > 0) {
        node.marks = Object.entries(op.attributes).map(([type, attrs]) => ({
          type,
          attrs: typeof attrs === "object" ? (attrs as Record<string, unknown>) : undefined,
        }));
      }

      result.push(node);
    }
  }

  return result;
}

function proseToText(prose: ProseContent): string {
  if (!prose || !("content" in prose) || !Array.isArray(prose.content)) {
    return "";
  }

  return prose.content
    .map((node: { type: string; content?: Array<{ type: string; text?: string }> }) => {
      if (node.type === "paragraph" && node.content) {
        return node.content
          .map((child) => (child.type === "text" ? child.text ?? "" : ""))
          .join("");
      }
      return "";
    })
    .join("\n");
}

function clearFragment(fragment: YXmlFragment): void {
  while (fragment.length > 0) {
    fragment.delete(0, 1);
  }
}

function appendNodeToFragment(
  parent: YXmlFragment | YXmlElement,
  node: XmlNodeJSON
): void {
  if (node.type === "text") {
    const text = new Y.XmlText();
    if (node.text) {
      const attrs: Record<string, unknown> = {};
      if (node.marks) {
        for (const mark of node.marks) {
          attrs[mark.type] = mark.attrs ?? true;
        }
      }
      text.insert(0, node.text, Object.keys(attrs).length > 0 ? attrs : undefined);
    }
    parent.insert(parent.length, [text]);
  } else {
    const element = new Y.XmlElement(node.type);

    if (node.attrs) {
      for (const [key, value] of Object.entries(node.attrs)) {
        element.setAttribute(key, value as string);
      }
    }

    if (node.content) {
      for (const child of node.content) {
        appendNodeToFragment(element, child);
      }
    }

    parent.insert(parent.length, [element]);
  }
}

function textToProse(text: string): XmlFragmentJSON {
  if (!text.trim()) {
    return {
      type: "doc",
      content: [],
    };
  }

  const paragraphs = text.split("\n").map((line) => ({
    type: "paragraph" as const,
    content: line ? [{ type: "text" as const, text: line }] : [],
  }));

  return {
    type: "doc",
    content: paragraphs,
  };
}

const DEBOUNCE_MS = 1000;

export function useProseField(document: string | null) {
  const [text, setText] = useState("");
  const [isReady, setIsReady] = useState(false);
  const fragmentRef = useRef<YXmlFragment | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedTextRef = useRef("");
  const isSavingRef = useRef(false);

  const saveToFragment = useCallback((newText: string) => {
    const fragment = fragmentRef.current;
    if (!fragment?.doc) return;
    if (newText === lastSavedTextRef.current) return;

    isSavingRef.current = true;
    fragment.doc.transact(() => {
      clearFragment(fragment);
      const proseJson = textToProse(newText);
      if (proseJson.content) {
        for (const node of proseJson.content) {
          appendNodeToFragment(fragment, node);
        }
      }
    });
    lastSavedTextRef.current = newText;
    isSavingRef.current = false;
  }, []);

  const debouncedSave = useCallback((newText: string) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      saveToFragment(newText);
    }, DEBOUNCE_MS);
  }, [saveToFragment]);

  useEffect(() => {
    if (!document) return;

    let cleanup: (() => void) | undefined;
    let mounted = true;

    intervals
      .get()
      .utils.prose(document, "description")
      .then((binding) => {
        if (!mounted) return;

        const frag = binding.fragment as YXmlFragment;
        fragmentRef.current = frag;

        const readFragment = () => {
          if (!frag.doc) return "";
          const json = fragmentToJSON(frag);
          return proseToText(json as ProseContent);
        };

        const initialText = readFragment();
        setText(initialText);
        lastSavedTextRef.current = initialText;
        setIsReady(true);

        const observer = () => {
          if (!mounted || !frag.doc || isSavingRef.current) return;
          const currentText = readFragment();
          if (currentText !== lastSavedTextRef.current) {
            setText(currentText);
            lastSavedTextRef.current = currentText;
          }
        };

        frag.observeDeep(observer);
        cleanup = () => frag.unobserveDeep(observer);
      })
      .catch((err) => {
        console.error("Failed to get prose binding:", err);
      });

    return () => {
      mounted = false;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      cleanup?.();
    };
  }, [document]);

  const handleChangeText = useCallback((newText: string) => {
    setText(newText);
    debouncedSave(newText);
  }, [debouncedSave]);

  return {
    text,
    isReady,
    handleChangeText,
  };
}
