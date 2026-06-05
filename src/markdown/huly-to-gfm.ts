import { type MarkupNode, markupToJSON } from '@hcengineering/text'
import { MarkdownState, storeNodes, storeMarks } from '@hcengineering/text-markdown'

type NodeHandler = (state: MarkdownState, node: MarkupNode) => void
type StoreNodesMap = Record<string, NodeHandler>

/**
 * Build a storeNodes map with the table handler replaced by a GFM pipe-table serializer.
 *
 * The default storeNodes['table'] renders HTML; this override produces
 * the | col | col | format that GitLab understands.
 *
 * The refUrl/imageUrl are captured at build time so the cell sub-serializer
 * uses the same URL base as the outer serialization pass.
 */
function buildGfmStoreNodes (refUrl: string, imageUrl: string): StoreNodesMap {
  const gfmNodes: StoreNodesMap = {
    ...(storeNodes as StoreNodesMap)
  }

  function cellText (cellNode: MarkupNode): string {
    const cellState = new MarkdownState(gfmNodes, storeMarks, { tightLists: true, refUrl, imageUrl })
    for (const child of (cellNode.content ?? [])) {
      if (child.type === 'paragraph') {
        cellState.renderInline(child)
      } else {
        cellState.render(child)
      }
    }
    return cellState.out.trim()
  }

  function renderRow (cells: MarkupNode[]): string {
    return '| ' + cells.map((c) => cellText(c)).join(' | ') + ' |'
  }

  gfmNodes.table = (state: MarkdownState, tableNode: MarkupNode): void => {
    const rows = (tableNode.content ?? [])
    if (rows.length === 0) return

    const headerCells = (rows[0].content ?? [])
    const bodyRows = rows.slice(1)
    // |---|---| separator style — no extra spaces, matches GFM canonical form
    const sep = '|' + headerCells.map(() => '---|').join('')

    const lines = [
      renderRow(headerCells),
      sep,
      ...bodyRows.map((row) => renderRow((row.content ?? [])))
    ]
    state.write(lines.join('\n'))
    state.closeBlock(tableNode)
  }

  return gfmNodes
}

/**
 * Serializes a ProseMirror MarkupNode to GFM markdown.
 */
function serializeMarkupNode (node: MarkupNode, refUrl: string, imageUrl: string): string {
  const gfmNodes = buildGfmStoreNodes(refUrl, imageUrl)
  const state = new MarkdownState(gfmNodes, storeMarks, { tightLists: true, refUrl, imageUrl })
  state.renderContent(node)
  return state.out
}

/**
 * Converts a Huly markup string to GFM markdown.
 * Parallels pod-github's `markupToMarkdown`.
 *
 * @param markup       - Huly markup string (serialised ProseMirror JSON)
 * @param refUrl       - base URL for relative document references
 * @param imageUrl     - base URL for relative image references
 * @param preprocessor - optional transform applied to the MarkupNode before serialisation
 */
export function markupToGfmMarkdown (
  markup: string,
  refUrl: string,
  imageUrl: string,
  preprocessor?: (m: MarkupNode) => MarkupNode
): string {
  let node = markupToJSON(markup)
  if (preprocessor !== undefined) {
    node = preprocessor(node)
  }
  return serializeMarkupNode(node, refUrl, imageUrl)
}
