import {
  extractAttachmentLinks,
  rewriteAttachmentLinks,
  resolveGitLabUploadUrl,
  MAX_ATTACHMENT_BYTES
} from '../../src/sync/attachment-links'

const GL_BASE = 'https://gitlab.example'
const PROJECT = 'group/project'

describe('extractAttachmentLinks', () => {
  it('extracts a relative GitLab upload image link', () => {
    const body = '![screenshot](/uploads/abc123/shot.png)'
    const links = extractAttachmentLinks(body, GL_BASE)
    expect(links).toHaveLength(1)
    expect(links[0].sourceUrl).toBe('/uploads/abc123/shot.png')
    expect(links[0].alt).toBe('screenshot')
    expect(links[0].filename).toBe('shot.png')
    expect(links[0].kind).toBe('image')
    expect(links[0].origin).toBe('gitlab')
  })

  it('extracts a relative GitLab upload plain link', () => {
    const body = '[download](/uploads/def456/file.zip)'
    const links = extractAttachmentLinks(body, GL_BASE)
    expect(links).toHaveLength(1)
    expect(links[0].kind).toBe('link')
    expect(links[0].origin).toBe('gitlab')
  })

  it('extracts an absolute GitLab upload image link', () => {
    const body = `![img](${GL_BASE}/${PROJECT}/uploads/ff00/img.jpg)`
    const links = extractAttachmentLinks(body, GL_BASE)
    expect(links).toHaveLength(1)
    expect(links[0].origin).toBe('gitlab')
    expect(links[0].filename).toBe('img.jpg')
  })

  it('extracts a Huly attachment link', () => {
    const body = '![file](attachments://some-ref-uuid)'
    const links = extractAttachmentLinks(body)
    expect(links).toHaveLength(1)
    expect(links[0].origin).toBe('huly')
    expect(links[0].sourceUrl).toBe('attachments://some-ref-uuid')
  })

  it('skips plain web links', () => {
    const body = '[Google](https://google.com) and ![img](https://example.com/img.png)'
    const links = extractAttachmentLinks(body, GL_BASE)
    expect(links).toHaveLength(0)
  })

  it('handles mixed-content body with multiple link types', () => {
    const body = [
      'Some text',
      '![gl-img](/uploads/aa/image.png)',
      '[web](https://example.com/page)',
      '[huly-file](attachments://ref-123)',
      '![gl-abs](https://gitlab.example/group/project/uploads/bb/doc.pdf)'
    ].join('\n')
    const links = extractAttachmentLinks(body, GL_BASE)
    expect(links).toHaveLength(3)
    expect(links.map((l) => l.origin)).toEqual(['gitlab', 'huly', 'gitlab'])
  })

  it('handles links with query strings', () => {
    const body = '![pic](/uploads/cc/photo.png?token=xyz&size=large)'
    const links = extractAttachmentLinks(body, GL_BASE)
    expect(links).toHaveLength(1)
    // filename strips query string
    expect(links[0].filename).toBe('photo.png')
  })

  it('handles links with non-ASCII filenames', () => {
    const body = '![file](/uploads/dd/%E6%96%87%E4%BB%B6.txt)'
    const links = extractAttachmentLinks(body, GL_BASE)
    expect(links).toHaveLength(1)
    // decoded filename
    expect(links[0].filename).toBe('文件.txt')
  })

  it('returns empty array for body with no attachment links', () => {
    const body = 'Just some **markdown** text with no links.'
    expect(extractAttachmentLinks(body, GL_BASE)).toHaveLength(0)
  })

  it('returns empty array for empty body', () => {
    expect(extractAttachmentLinks('', GL_BASE)).toHaveLength(0)
  })

  it('does not extract non-gitlab absolute URLs even if they contain /uploads/', () => {
    const body = '![img](https://other.example.com/uploads/aa/img.png)'
    // baseUrl filter: only gitlab.example URLs
    const links = extractAttachmentLinks(body, GL_BASE)
    expect(links).toHaveLength(0)
  })

  it('markdownIndex is 0-based index within matched markdown links', () => {
    const body = '[a](https://normal.com) ![b](/uploads/e1/b.png) [c](attachments://ref)'
    const links = extractAttachmentLinks(body, GL_BASE)
    // first markdown link (index 0) is normal — skipped
    // second (index 1) is GitLab upload
    // third (index 2) is Huly
    expect(links[0].markdownIndex).toBe(1)
    expect(links[1].markdownIndex).toBe(2)
  })
})

describe('rewriteAttachmentLinks', () => {
  it('rewrites a single URL', () => {
    const body = '![pic](/uploads/aa/pic.png)'
    const result = rewriteAttachmentLinks(body, [
      { sourceUrl: '/uploads/aa/pic.png', targetUrl: 'attachments://new-ref' }
    ])
    expect(result).toBe('![pic](attachments://new-ref)')
  })

  it('rewrites multiple URLs', () => {
    const body = '![a](/uploads/1/a.png) text ![b](/uploads/2/b.png)'
    const result = rewriteAttachmentLinks(body, [
      { sourceUrl: '/uploads/1/a.png', targetUrl: 'attachments://ref-a' },
      { sourceUrl: '/uploads/2/b.png', targetUrl: 'attachments://ref-b' }
    ])
    expect(result).toBe('![a](attachments://ref-a) text ![b](attachments://ref-b)')
  })

  it('is a no-op when sourceUrl === targetUrl', () => {
    const body = '![pic](/uploads/aa/pic.png)'
    const result = rewriteAttachmentLinks(body, [
      { sourceUrl: '/uploads/aa/pic.png', targetUrl: '/uploads/aa/pic.png' }
    ])
    expect(result).toBe(body)
  })

  it('is a no-op with empty mappings', () => {
    const body = '![pic](/uploads/aa/pic.png)'
    expect(rewriteAttachmentLinks(body, [])).toBe(body)
  })

  it('leaves unmapped URLs unchanged', () => {
    const body = '![a](/uploads/1/a.png) ![b](/uploads/2/b.png)'
    const result = rewriteAttachmentLinks(body, [
      { sourceUrl: '/uploads/1/a.png', targetUrl: 'attachments://ref-a' }
    ])
    expect(result).toContain('attachments://ref-a')
    expect(result).toContain('/uploads/2/b.png')
  })

  it('preserves alt text exactly', () => {
    const body = '![My File (v2)](/uploads/z/file.zip)'
    const result = rewriteAttachmentLinks(body, [
      { sourceUrl: '/uploads/z/file.zip', targetUrl: 'attachments://ref-z' }
    ])
    expect(result).toBe('![My File (v2)](attachments://ref-z)')
  })

  it('idempotent: rewriting already-rewritten body is a no-op', () => {
    const body = '![pic](attachments://ref-aa)'
    const result = rewriteAttachmentLinks(body, [
      { sourceUrl: 'attachments://ref-aa', targetUrl: 'attachments://ref-aa' }
    ])
    expect(result).toBe(body)
  })

  it('handles plain (non-image) links', () => {
    const body = '[download](/uploads/q/file.zip)'
    const result = rewriteAttachmentLinks(body, [
      { sourceUrl: '/uploads/q/file.zip', targetUrl: 'attachments://ref-q' }
    ])
    expect(result).toBe('[download](attachments://ref-q)')
  })
})

describe('resolveGitLabUploadUrl', () => {
  it('absolutizes a relative upload path', () => {
    const result = resolveGitLabUploadUrl('/uploads/abc/file.png', 'https://gitlab.example', 'group/project')
    expect(result).toBe('https://gitlab.example/group/project/uploads/abc/file.png')
  })

  it('leaves an already-absolute URL unchanged', () => {
    const url = 'https://gitlab.example/group/project/uploads/abc/file.png'
    expect(resolveGitLabUploadUrl(url, 'https://gitlab.example', 'group/project')).toBe(url)
  })

  it('strips trailing slash from baseUrl', () => {
    const result = resolveGitLabUploadUrl('/uploads/x/y.png', 'https://gitlab.example/', 'g/p')
    expect(result).toBe('https://gitlab.example/g/p/uploads/x/y.png')
  })
})

describe('MAX_ATTACHMENT_BYTES', () => {
  it('is 25 MB', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024)
  })
})
