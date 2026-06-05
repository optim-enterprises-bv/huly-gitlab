import { type MarkupNode, jsonToMarkup } from '@hcengineering/text'
import { MarkdownParser } from '@hcengineering/text-markdown'

/**
 * Parses a GFM markdown string into a ProseMirror MarkupNode (JSON AST).
 *
 * @param message - GFM markdown source
 * @param refUrl  - base URL used to resolve relative document references
 * @param imageUrl - base URL used to resolve relative image references
 */
export function parseGfmMarkdown (message: string, refUrl: string, imageUrl: string): MarkupNode {
  const parser = new MarkdownParser({ refUrl, imageUrl })
  return parser.parse(message ?? '')
}

/**
 * Converts a GFM markdown string to a Huly markup string (serialised ProseMirror JSON).
 * Parallels pod-github's `markdownToMarkup`.
 *
 * @param message  - GFM markdown source
 * @param refUrl   - base URL for relative document references
 * @param imageUrl - base URL for relative image references
 */
export function gfmMarkdownToMarkup (message: string, refUrl: string, imageUrl: string): string {
  const node = parseGfmMarkdown(message, refUrl, imageUrl)
  return jsonToMarkup(node)
}
