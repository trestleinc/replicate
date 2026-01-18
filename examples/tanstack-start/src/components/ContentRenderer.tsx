import type { ReactNode } from "react";
import type { XmlFragmentJSON, XmlNodeJSON } from "@trestleinc/replicate";

// Safe URL protocols for sanitization (prevents javascript: XSS)
const SAFE_URL_PROTOCOLS = ["http:", "https:", "mailto:", "tel:"];

function sanitizeUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const parsed = new URL(url, "https://placeholder.com");
		return SAFE_URL_PROTOCOLS.includes(parsed.protocol) ? url : undefined;
	} catch {
		return undefined;
	}
}

// Generate stable key from node content
function getNodeKey(node: XmlNodeJSON, index: number): string {
	const type = node.type || "unknown";
	const text = node.text?.slice(0, 20) || "";
	return `${type}-${index}-${text}`;
}

interface ContentRendererProps {
	content: XmlFragmentJSON;
}

/**
 * Renders BlockNote/ProseMirror JSON content as static HTML for SSR.
 * Expects XmlFragmentJSON: { type: 'doc', content?: XmlNodeJSON[] }
 */
export function ContentRenderer({ content }: ContentRendererProps) {
	if (!content?.content?.length) {
		return <p className="text-muted italic">Empty page</p>;
	}

	return (
		<div className="prose prose-notebook">
			{content.content.map((block, i) => (
				<BlockRenderer key={getNodeKey(block, i)} node={block} />
			))}
		</div>
	);
}

interface BlockRendererProps {
	node: XmlNodeJSON;
}

function BlockRenderer({ node }: BlockRendererProps) {
	switch (node.type) {
		case "paragraph":
			return (
				<p>
					<InlineRenderer content={node.content} />
				</p>
			);

		case "heading": {
			const level = Math.max(1, Math.min((node.attrs?.level as number) || 1, 6));
			const HeadingTag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
			return (
				<HeadingTag>
					<InlineRenderer content={node.content} />
				</HeadingTag>
			);
		}

		case "bulletListItem":
			return (
				<li>
					<InlineRenderer content={node.content} />
					{node.content
						?.filter(c => c.type !== "text")
						.map((child, i) => (
							<BlockRenderer key={getNodeKey(child, i)} node={child} />
						))}
				</li>
			);

		case "numberedListItem":
			return (
				<li>
					<InlineRenderer content={node.content} />
					{node.content
						?.filter(c => c.type !== "text")
						.map((child, i) => (
							<BlockRenderer key={getNodeKey(child, i)} node={child} />
						))}
				</li>
			);

		case "checkListItem": {
			const checked = node.attrs?.checked as boolean;
			return (
				<li className={`check-item ${checked ? "checked" : ""}`}>
					<span className="check-box">{checked ? "☑" : "☐"}</span>
					<InlineRenderer content={node.content} />
				</li>
			);
		}

		case "codeBlock":
			return (
				<pre>
					<code>
						<InlineRenderer content={node.content} />
					</code>
				</pre>
			);

		case "blockquote":
			return (
				<blockquote>
					{node.content?.map((child, i) => (
						<BlockRenderer key={getNodeKey(child, i)} node={child} />
					))}
				</blockquote>
			);

		case "image": {
			const imgSrc = sanitizeUrl(node.attrs?.src as string);
			return (
				<figure>
					{imgSrc ? (
						<img src={imgSrc} alt={(node.attrs?.alt as string) || ""} />
					) : (
						<span className="text-muted">[Invalid image URL]</span>
					)}
					{node.attrs?.caption ? <figcaption>{String(node.attrs.caption)}</figcaption> : null}
				</figure>
			);
		}

		case "table":
			return (
				<table>
					<tbody>
						{node.content?.map((row, i) => (
							<tr key={getNodeKey(row, i)}>
								{row.content?.map((cell, j) => (
									<td key={getNodeKey(cell, j)}>
										<InlineRenderer content={cell.content} />
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			);

		case "horizontalRule":
			return <hr />;

		default:
			// For unknown block types, try to render content
			if (node.content) {
				return (
					<div>
						{node.content.map((child, i) => (
							<BlockRenderer key={getNodeKey(child, i)} node={child} />
						))}
					</div>
				);
			}
			return null;
	}
}

interface InlineRendererProps {
	content?: XmlNodeJSON[];
}

function InlineRenderer({ content }: InlineRendererProps) {
	if (!content) return null;

	return (
		<>
			{content.map((node, i) => {
				const key = getNodeKey(node, i);
				if (node.type === "text") {
					let element: ReactNode = node.text || "";

					// Apply marks (bold, italic, etc.)
					if (node.marks) {
						for (const mark of node.marks) {
							switch (mark.type) {
								case "bold":
									element = <strong>{element}</strong>;
									break;
								case "italic":
									element = <em>{element}</em>;
									break;
								case "strike":
									element = <s>{element}</s>;
									break;
								case "underline":
									element = <u>{element}</u>;
									break;
								case "code":
									element = <code>{element}</code>;
									break;
								case "link": {
									const href = sanitizeUrl(mark.attrs?.href as string);
									element = href ? (
										<a href={href} rel="noopener noreferrer" target="_blank">
											{element}
										</a>
									) : (
										<span>{element}</span>
									);
									break;
								}
							}
						}
					}

					return <span key={key}>{element}</span>;
				}

				// Handle nested blocks within inline content
				return <BlockRenderer key={key} node={node} />;
			})}
		</>
	);
}
