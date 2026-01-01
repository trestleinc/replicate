import type { Interval } from "@/types/interval";

type ProseContent = Interval["description"];

export function textToProse(text: string): ProseContent {
  if (!text.trim()) {
    return {
      type: "doc",
      content: [],
    } as ProseContent;
  }

  const paragraphs = text.split("\n").map((line) => ({
    type: "paragraph" as const,
    content: line ? [{ type: "text" as const, text: line }] : [],
  }));

  return {
    type: "doc",
    content: paragraphs,
  } as ProseContent;
}

export function proseToText(prose: ProseContent): string {
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
