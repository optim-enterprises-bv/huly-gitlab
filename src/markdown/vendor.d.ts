/**
 * Ambient module declarations for @hcengineering/text and @hcengineering/text-markdown.
 * These packages ship without TypeScript declaration files; the declarations below
 * cover only the API surface used by src/markdown/*.
 */

declare module '@hcengineering/text' {
  export interface MarkupNode {
    type: string
    text?: string
    attrs?: Record<string, unknown>
    marks?: Array<{ type: string, attrs?: Record<string, unknown> }>
    content?: MarkupNode[]
  }

  export function jsonToMarkup (node: MarkupNode): string
  export function markupToJSON (markup: string): MarkupNode
  export function htmlToJSON (html: string, extensions: unknown[]): MarkupNode

  export type ExtensionKitOptions = Record<string, unknown>

  export interface ExtensionKitEntry {
    extension: unknown
    options?: unknown
  }

  // extensionKit creates a named Tiptap Extension composite
  export function extensionKit (
    name: string,
    fn: (e: (ext: unknown, opts?: unknown) => ExtensionKitEntry) => Record<string, ExtensionKitEntry>
  ): unknown

  export const ServerKit: unknown
  export const defaultExtensions: unknown[]

  // Re-exported node/mark constructors (not used in markdown adapter but part of public API)
  export const markBold: unknown
  export const markItalic: unknown
  export const markCode: unknown
  export const markLink: unknown
  export const markStrike: unknown
  export const nodeDoc: unknown
  export const nodeParagraph: unknown
  export const nodeText: unknown
  export const nodeImage: unknown
  export const nodeReference: unknown

  export const EmptyMarkup: string
  export function isEmptyMarkup (markup: string): boolean
  export function markupToText (markup: string): string
}

declare module '@hcengineering/text-markdown' {
  import type { MarkupNode } from '@hcengineering/text'

  export interface MarkdownParserOptions {
    refUrl: string
    imageUrl: string
    htmlParser?: (html: string) => MarkupNode
  }

  export interface MarkdownStateOptions {
    tightLists?: boolean
    refUrl: string
    imageUrl: string
  }

  export type NodeHandler = (state: MarkdownState, node: MarkupNode) => void
  export type MarkHandler = (state: MarkdownState, mark: unknown, open: boolean) => string

  export class MarkdownParser {
    constructor (options: MarkdownParserOptions)
    parse (markdown: string): MarkupNode
  }

  export class MarkdownState {
    out: string
    refUrl: string
    imageUrl: string
    options: MarkdownStateOptions
    nodes: Record<string, NodeHandler>
    marks: Record<string, MarkHandler>

    constructor (
      nodes: Record<string, NodeHandler>,
      marks: Record<string, MarkHandler>,
      options: MarkdownStateOptions
    )

    renderContent (node: MarkupNode): void
    renderInline (node: MarkupNode): void
    render (node: MarkupNode, parent?: MarkupNode, index?: number): void
    write (text: string): void
    closeBlock (node: MarkupNode): void
    text (text: string, escape?: boolean): void
    ensureNewLine (): void
    atBlank (): boolean
    esc (str: string, startOfLine?: boolean): string
  }

  export const storeNodes: Record<string, NodeHandler>
  export const storeMarks: Record<string, MarkHandler>

  export function markdownToMarkup (
    message: string,
    refUrl?: string,
    imageUrl?: string
  ): MarkupNode

  export function markupToMarkdown (markup: string, refUrl?: string, imageUrl?: string): string

  export function isMarkdownsEquals (a: string, b: string): boolean
  export function normalizeMarkdown (md: string): string
}
