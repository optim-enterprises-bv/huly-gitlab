import { extensionKit, ServerKit } from '@hcengineering/text'

/**
 * GitLabKit — Tiptap extension set for parsing and serializing GitLab-flavored markdown.
 *
 * Phase 1 note: GitLab-specific reference tokens (~label, %milestone, @user, #123, !123)
 * and quick actions (/assign, /close, etc.) are preserved as plain text. No resolution
 * is attempted. The MarkdownParser already treats them as inline text, so no custom
 * markdown-it plugin is needed for round-trip fidelity.
 */
export const GitLabKit = extensionKit(
  'gitlab',
  (e) =>
    ({
      serverKit: e(ServerKit, {
        image: {
          getBlobRef: async () => ({ src: '', srcset: '' })
        }
      })
    }) as const
)

export const defaultExtensions = [GitLabKit]
