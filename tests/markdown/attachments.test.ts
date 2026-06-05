import { rewriteAttachmentUrls, isGitLabUploadUrl } from '../../src/markdown/attachments'
import type { AttachmentBinding } from '../../src/markdown/attachments'

const binding: AttachmentBinding = {
  gitlabBaseUrl: 'https://gitlab.example',
  projectPath: 'group/myproject'
}

describe('rewriteAttachmentUrls — gfm-to-huly', () => {
  it('absolutizes relative /uploads/ image reference', () => {
    const md = '![screenshot](/uploads/abc123def456/screenshot.png)'
    const result = rewriteAttachmentUrls(md, 'gfm-to-huly', binding)
    expect(result).toBe(
      '![screenshot](https://gitlab.example/group/myproject/uploads/abc123def456/screenshot.png)'
    )
  })

  it('absolutizes relative /uploads/ link reference', () => {
    const md = '[download](/uploads/deadbeef/document.pdf)'
    const result = rewriteAttachmentUrls(md, 'gfm-to-huly', binding)
    expect(result).toBe('[download](https://gitlab.example/group/myproject/uploads/deadbeef/document.pdf)')
  })

  it('leaves already-absolute GitLab upload URL unchanged', () => {
    const md = '![img](https://gitlab.example/group/myproject/uploads/abc/img.png)'
    const result = rewriteAttachmentUrls(md, 'gfm-to-huly', binding)
    // Already absolute — also matched by the regex since /uploads/ is present; the replacement
    // would double-absolutize. Verify current behavior is documented.
    // The regex only matches /uploads/... not https://... so absolute URLs pass through
    expect(result).toBe(md)
  })

  it('leaves non-upload URLs unchanged', () => {
    const md = '[link](https://example.com/foo/bar)'
    const result = rewriteAttachmentUrls(md, 'gfm-to-huly', binding)
    expect(result).toBe(md)
  })

  it('handles multiple upload references in one string', () => {
    const md = '![a](/uploads/hash1/a.png) and ![b](/uploads/hash2/b.jpg)'
    const result = rewriteAttachmentUrls(md, 'gfm-to-huly', binding)
    expect(result).toBe(
      '![a](https://gitlab.example/group/myproject/uploads/hash1/a.png) and ' +
        '![b](https://gitlab.example/group/myproject/uploads/hash2/b.jpg)'
    )
  })
})

describe('rewriteAttachmentUrls — huly-to-gfm', () => {
  it('passes through attachments:// references unchanged', () => {
    const md = '[file](attachments://some-huly-ref-id)'
    const result = rewriteAttachmentUrls(md, 'huly-to-gfm', binding)
    expect(result).toBe(md)
  })

  it('passes through absolute GitLab upload URLs unchanged', () => {
    const md = '![img](https://gitlab.example/group/myproject/uploads/abc/img.png)'
    const result = rewriteAttachmentUrls(md, 'huly-to-gfm', binding)
    expect(result).toBe(md)
  })

  it('passes through plain text unchanged', () => {
    const md = 'No attachments here, just text'
    const result = rewriteAttachmentUrls(md, 'huly-to-gfm', binding)
    expect(result).toBe(md)
  })

  it('passes through relative /uploads/ path unchanged (Phase 1 limitation — no upload sync)', () => {
    // In huly-to-gfm, we do not re-relativize because we have no upload sync
    const md = '![img](/uploads/abc/img.png)'
    const result = rewriteAttachmentUrls(md, 'huly-to-gfm', binding)
    expect(result).toBe(md)
  })
})

describe('isGitLabUploadUrl', () => {
  it('returns true for absolute GitLab upload URL matching the project', () => {
    expect(
      isGitLabUploadUrl('https://gitlab.example/group/myproject/uploads/abc/file.png', binding)
    ).toBe(true)
  })

  it('returns false for a non-upload URL', () => {
    expect(isGitLabUploadUrl('https://example.com/foo.png', binding)).toBe(false)
  })

  it('returns false for a relative /uploads/ path', () => {
    expect(isGitLabUploadUrl('/uploads/abc/file.png', binding)).toBe(false)
  })
})
