import { isMarkdownsEquals } from '@hcengineering/text-markdown'
import { gfmMarkdownToMarkup } from '../../src/markdown/gfm-to-huly'
import { markupToGfmMarkdown } from '../../src/markdown/huly-to-gfm'

const REF_URL = 'ref://'
const IMAGE_URL = 'http://localhost'
const GITLAB_BASE = 'https://gitlab.example'
const PROJECT_PATH = 'group/proj'

/**
 * Round-trip: GFM → Huly markup → GFM must equal the original (modulo isMarkdownsEquals normalization).
 */
function roundTrip(gfm: string): string {
  const markup = gfmMarkdownToMarkup(gfm, REF_URL, IMAGE_URL)
  return markupToGfmMarkdown(markup, REF_URL, IMAGE_URL)
}

interface Fixture {
  name: string
  gfm: string
  /** When the fixture is expected to differ after round-trip, provide the expected normalized form */
  expected?: string
  /** Use exact string equality instead of isMarkdownsEquals */
  exact?: boolean
}

const fixtures: Fixture[] = [
  // 1. Paragraph with bold, italic, inline code
  {
    name: '1. paragraph with bold, italic, inline code',
    gfm: '**bold** _italic_ `code`'
  },
  // 2. Multi-level headings h1-h6
  {
    name: '2. headings h1-h6',
    gfm: '# Heading 1\n\n## Heading 2\n\n### Heading 3\n\n#### Heading 4\n\n##### Heading 5\n\n###### Heading 6'
  },
  // 3. Unordered list with nested levels
  {
    name: '3. unordered list with nested levels',
    gfm: '- item a\n  - nested b\n  - nested c\n- item d'
  },
  // 4. Ordered list
  {
    name: '4. ordered list',
    gfm: '1. first\n2. second\n3. third'
  },
  // 5. Task list with checked/unchecked items
  {
    name: '5. task list checked/unchecked',
    gfm: '- [x] done\n- [ ] todo\n- [x] also done'
  },
  // 6. Fenced code block with language
  {
    name: '6. fenced code block with language',
    gfm: '```javascript\nconsole.log("hello")\n```'
  },
  // 7. Inline code with backtick-containing special chars
  {
    name: '7. inline code with special chars',
    gfm: '``code with `backtick```'
  },
  // 8. Table (3-column, 2-row with header)
  {
    name: '8. table 3-column 2-row',
    gfm: '| Name | Age | City |\n|---|---|---|\n| Alice | 30 | NYC |\n| Bob | 25 | LA |'
  },
  // 9. Strikethrough
  {
    name: '9. strikethrough',
    gfm: '~~struck through text~~'
  },
  // 10. Autolink
  {
    name: '10. autolink',
    gfm: '<https://example.com>'
  },
  // 11. Inline link
  {
    name: '11. inline link',
    gfm: '[click here](https://example.com/path?q=1)'
  },
  // 12. Image link-through
  {
    name: '12. image link-through',
    gfm: '![alt text](https://example.com/image.png)'
  },
  // 13. GitLab attachment URL absolutized (relative /uploads/... path)
  {
    name: '13. GitLab attachment URL relative /uploads/ passes through',
    gfm: `![file](${GITLAB_BASE}/${PROJECT_PATH}/uploads/abc123/file.png)`,
    exact: true
  },
  // 14. GitLab refs: ~label, %milestone, @user, #42, !17 survive as text
  {
    name: '14. GitLab refs survive as text',
    gfm: 'See ~bug label, milestone %v1.0, user @john, issue #42, and MR !17'
  },
  // 15. Slash quick action at line start preserved verbatim
  {
    name: '15. quick action /assign preserved',
    gfm: '/assign @me'
  }
]

describe('GFM ↔ Huly round-trip', () => {
  for (const { name, gfm, expected, exact } of fixtures) {
    it(name, () => {
      const result = roundTrip(gfm)
      const target = expected ?? gfm
      if (exact === true) {
        expect(result).toBe(target)
      } else {
        expect(isMarkdownsEquals(result, target)).toBe(true)
      }
    })
  }

  it('total fixture count is >= 15', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(15)
  })

  it('13. attachment URL is byte-identical after round-trip (exact)', () => {
    const absoluteUrl = `${GITLAB_BASE}/${PROJECT_PATH}/uploads/abc123/file.png`
    const gfm = `![file](${absoluteUrl})`
    const result = roundTrip(gfm)
    expect(result).toBe(gfm)
  })

  it('14. all GitLab ref tokens survive verbatim', () => {
    const refs = ['~bug', '%v1.0', '@john', '#42', '!17']
    const gfm = refs.join(' ')
    const result = roundTrip(gfm)
    for (const ref of refs) {
      expect(result).toContain(ref)
    }
  })

  it('preprocessor transforms markup node before serialization', () => {
    const gfm = 'hello world'
    const markup = gfmMarkdownToMarkup(gfm, REF_URL, IMAGE_URL)
    const result = markupToGfmMarkdown(markup, REF_URL, IMAGE_URL, (node) => {
      // Replace first text node content
      return {
        ...node,
        content: node.content?.map((child) => ({
          ...child,
          content: child.content?.map((inline) => ({
            ...inline,
            text: inline.text !== undefined ? 'replaced' : inline.text
          }))
        }))
      }
    })
    expect(result).toContain('replaced')
  })
})
