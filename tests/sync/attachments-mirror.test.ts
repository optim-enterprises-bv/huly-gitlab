import { createHash } from 'node:crypto'
import type { Collection } from 'mongodb'
import type { Logger } from '../../src/logging'
import type { AttachmentMirrorDoc } from '../../src/state/attachment-mirror'
import type { HulyAttachmentStore, AttachmentGitLabClient, MirrorDeps } from '../../src/sync/attachments'
import {
  mirrorGitlabUploadToHuly,
  mirrorHulyAttachmentToGitlab,
  mirrorBodyGitlabToHuly,
  mirrorBodyHulyToGitlab,
  MAX_ATTACHMENT_BYTES
} from '../../src/sync/attachments'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256 (buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function makeLogger (): Logger {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}

function makeMirrorCol (docs: AttachmentMirrorDoc[] = []): Collection<AttachmentMirrorDoc> {
  const store = [...docs]
  return {
    findOne: jest.fn(async (q: Record<string, unknown>) => {
      return store.find(
        (d) => d.contentHash === q.contentHash && d.origin === q.origin
      ) ?? null
    }),
    insertOne: jest.fn(async (doc: AttachmentMirrorDoc) => {
      store.push(doc)
      return { insertedId: doc._id }
    })
  } as unknown as Collection<AttachmentMirrorDoc>
}

function makeGitLabClient (
  fileBytes: Buffer = Buffer.from('test-content'),
  uploadUrl = 'https://gitlab.example/group/proj/uploads/aa/file.png'
): AttachmentGitLabClient {
  return {
    downloadUpload: jest.fn(async (_url: string) => fileBytes),
    uploadFile: jest.fn(async (_pid: number | string, filename: string, _bytes: Buffer) => ({
      url: uploadUrl,
      alt: filename,
      markdown: `![${filename}](${uploadUrl})`
    }))
  }
}

function makeHulyStore (
  fileBytes: Buffer = Buffer.from('huly-content'),
  ref = 'attachments://huly-ref-abc'
): HulyAttachmentStore {
  return {
    upload: jest.fn(async (_filename: string, _bytes: Buffer) => ({
      ref,
      url: ref
    })),
    download: jest.fn(async (_refOrUrl: string) => fileBytes)
  }
}

function makeDeps (overrides: Partial<{
  fileBytes: Buffer
  hulyRef: string
  gitlabUploadUrl: string
}> = {}): MirrorDeps & { col: Collection<AttachmentMirrorDoc>, logger: Logger } {
  const fileBytes = overrides.fileBytes ?? Buffer.from('test-content')
  const hulyRef = overrides.hulyRef ?? 'attachments://huly-ref-abc'
  const gitlabUploadUrl = overrides.gitlabUploadUrl ?? 'https://gitlab.example/group/proj/uploads/aa/file.png'
  const col = makeMirrorCol()
  const logger = makeLogger()
  return {
    gitlabClient: makeGitLabClient(fileBytes, gitlabUploadUrl),
    hulyStore: makeHulyStore(fileBytes, hulyRef),
    mirrorCol: col,
    logger,
    col
  }
}

// ---------------------------------------------------------------------------
// mirrorGitlabUploadToHuly
// ---------------------------------------------------------------------------

describe('mirrorGitlabUploadToHuly', () => {
  it('downloads from GitLab, uploads to Huly, returns Huly URL', async () => {
    const deps = makeDeps()
    const result = await mirrorGitlabUploadToHuly(
      deps,
      'https://gitlab.example/group/proj/uploads/aa/file.png',
      'file.png'
    )
    expect(result).toBe('attachments://huly-ref-abc')
    expect(deps.gitlabClient.downloadUpload).toHaveBeenCalledTimes(1)
    expect(deps.hulyStore.upload).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — second call reuses existing mapping without re-uploading', async () => {
    const fileBytes = Buffer.from('dedupe-content')
    const hash = sha256(fileBytes)
    const existingDoc: AttachmentMirrorDoc = {
      _id: {} as never,
      contentHash: hash,
      origin: 'gitlab',
      sourceUrl: 'https://gitlab.example/group/proj/uploads/bb/dup.png',
      targetUrl: 'attachments://cached-ref',
      createdAt: new Date()
    }
    const col = makeMirrorCol([existingDoc])
    const gitlabClient = makeGitLabClient(fileBytes)
    const hulyStore = makeHulyStore(fileBytes, 'attachments://should-not-be-used')
    const deps: MirrorDeps = { gitlabClient, hulyStore, mirrorCol: col, logger: makeLogger() }

    const result = await mirrorGitlabUploadToHuly(
      deps,
      'https://gitlab.example/group/proj/uploads/bb/dup.png',
      'dup.png'
    )
    expect(result).toBe('attachments://cached-ref')
    // Upload should NOT have been called
    expect(hulyStore.upload).not.toHaveBeenCalled()
  })

  it('returns null when GitLab 404 (file not found)', async () => {
    const col = makeMirrorCol()
    const gitlabClient: AttachmentGitLabClient = {
      downloadUpload: jest.fn(async () => null),
      uploadFile: jest.fn()
    }
    const hulyStore = makeHulyStore()
    const deps: MirrorDeps = { gitlabClient, hulyStore, mirrorCol: col, logger: makeLogger() }

    const result = await mirrorGitlabUploadToHuly(
      deps,
      'https://gitlab.example/group/proj/uploads/missing/file.png',
      'file.png'
    )
    expect(result).toBeNull()
  })

  it('returns null and logs when file exceeds size limit', async () => {
    const bigBytes = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0)
    const deps = makeDeps({ fileBytes: bigBytes })
    const logger = deps.logger

    const result = await mirrorGitlabUploadToHuly(
      deps,
      'https://gitlab.example/group/proj/uploads/big/huge.bin',
      'huge.bin'
    )
    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
    expect(deps.hulyStore.upload).not.toHaveBeenCalled()
  })

  it('returns null and logs on Huly upload error (does not throw)', async () => {
    const col = makeMirrorCol()
    const gitlabClient = makeGitLabClient()
    const hulyStore: HulyAttachmentStore = {
      upload: jest.fn(async () => { throw new Error('upload failed') }),
      download: jest.fn()
    }
    const logger = makeLogger()
    const deps: MirrorDeps = { gitlabClient, hulyStore, mirrorCol: col, logger }

    const result = await mirrorGitlabUploadToHuly(
      deps,
      'https://gitlab.example/group/proj/uploads/err/file.png',
      'file.png'
    )
    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// mirrorHulyAttachmentToGitlab
// ---------------------------------------------------------------------------

describe('mirrorHulyAttachmentToGitlab', () => {
  it('downloads from Huly, uploads to GitLab, returns GitLab URL', async () => {
    const deps = makeDeps()
    const result = await mirrorHulyAttachmentToGitlab(
      deps,
      'attachments://ref-xyz',
      'image.png',
      42
    )
    expect(result).toBe('https://gitlab.example/group/proj/uploads/aa/file.png')
    expect(deps.hulyStore.download).toHaveBeenCalledTimes(1)
    expect(deps.gitlabClient.uploadFile).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — second call reuses existing mapping without re-uploading', async () => {
    const fileBytes = Buffer.from('huly-dedupe-content')
    const hash = sha256(fileBytes)
    const existingDoc: AttachmentMirrorDoc = {
      _id: {} as never,
      contentHash: hash,
      origin: 'huly',
      sourceUrl: 'attachments://ref-cached',
      targetUrl: 'https://gitlab.example/group/proj/uploads/cc/cached.png',
      createdAt: new Date()
    }
    const col = makeMirrorCol([existingDoc])
    const gitlabClient = makeGitLabClient(fileBytes)
    const hulyStore = makeHulyStore(fileBytes, 'attachments://ref-cached')
    const deps: MirrorDeps = { gitlabClient, hulyStore, mirrorCol: col, logger: makeLogger() }

    const result = await mirrorHulyAttachmentToGitlab(deps, 'attachments://ref-cached', 'cached.png', 42)
    expect(result).toBe('https://gitlab.example/group/proj/uploads/cc/cached.png')
    expect(gitlabClient.uploadFile).not.toHaveBeenCalled()
  })

  it('returns null and logs when file exceeds size limit', async () => {
    const bigBytes = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0)
    const col = makeMirrorCol()
    const gitlabClient = makeGitLabClient()
    const hulyStore: HulyAttachmentStore = {
      upload: jest.fn(),
      download: jest.fn(async () => bigBytes)
    }
    const logger = makeLogger()
    const deps: MirrorDeps = { gitlabClient, hulyStore, mirrorCol: col, logger }

    const result = await mirrorHulyAttachmentToGitlab(deps, 'attachments://big', 'big.bin', 42)
    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
    expect(gitlabClient.uploadFile).not.toHaveBeenCalled()
  })

  it('returns null and logs on GitLab upload error (does not throw)', async () => {
    const col = makeMirrorCol()
    const gitlabClient: AttachmentGitLabClient = {
      downloadUpload: jest.fn(),
      uploadFile: jest.fn(async () => { throw new Error('gitlab upload failed') })
    }
    const hulyStore = makeHulyStore()
    const logger = makeLogger()
    const deps: MirrorDeps = { gitlabClient, hulyStore, mirrorCol: col, logger }

    const result = await mirrorHulyAttachmentToGitlab(deps, 'attachments://err', 'err.png', 42)
    expect(result).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// mirrorBodyGitlabToHuly
// ---------------------------------------------------------------------------

describe('mirrorBodyGitlabToHuly', () => {
  it('rewrites GitLab upload links in a markdown body', async () => {
    const fileBytes = Buffer.from('img-data')
    const deps = makeDeps({ fileBytes, hulyRef: 'attachments://new-ref' })

    const body = '# Title\n\n![screenshot](/uploads/aa/shot.png)\n\nSome text.'
    const result = await mirrorBodyGitlabToHuly(deps, body, 'https://gitlab.example', 'group/project')

    expect(result).toContain('attachments://new-ref')
    expect(result).not.toContain('/uploads/aa/shot.png')
  })

  it('returns body unchanged when no GitLab upload links present', async () => {
    const deps = makeDeps()
    const body = 'No attachments here, just [a link](https://example.com).'
    const result = await mirrorBodyGitlabToHuly(deps, body, 'https://gitlab.example', 'group/project')
    expect(result).toBe(body)
  })

  it('preserves alt text in rewritten links', async () => {
    const deps = makeDeps({ hulyRef: 'attachments://preserved-ref' })
    const body = '![My Screenshot](/uploads/aa/shot.png)'
    const result = await mirrorBodyGitlabToHuly(deps, body, 'https://gitlab.example', 'group/project')
    expect(result).toBe('![My Screenshot](attachments://preserved-ref)')
  })

  it('falls back to original link when mirror returns null', async () => {
    const col = makeMirrorCol()
    const gitlabClient: AttachmentGitLabClient = {
      downloadUpload: jest.fn(async () => null),
      uploadFile: jest.fn()
    }
    const hulyStore = makeHulyStore()
    const deps: MirrorDeps = { gitlabClient, hulyStore, mirrorCol: col, logger: makeLogger() }

    const body = '![img](/uploads/missing/img.png)'
    const result = await mirrorBodyGitlabToHuly(deps, body, 'https://gitlab.example', 'group/project')
    // Original link preserved
    expect(result).toBe(body)
  })
})

// ---------------------------------------------------------------------------
// mirrorBodyHulyToGitlab
// ---------------------------------------------------------------------------

describe('mirrorBodyHulyToGitlab', () => {
  it('rewrites Huly attachment links in a markdown body', async () => {
    const gitlabUrl = 'https://gitlab.example/group/proj/uploads/bb/file.png'
    const deps = makeDeps({ gitlabUploadUrl: gitlabUrl })

    const body = '![file](attachments://huly-ref-abc) end'
    const result = await mirrorBodyHulyToGitlab(deps, body, 42)

    expect(result).toContain(gitlabUrl)
    expect(result).not.toContain('attachments://huly-ref-abc')
  })

  it('returns body unchanged when no Huly attachment links present', async () => {
    const deps = makeDeps()
    const body = 'Text with ![img](/uploads/aa/img.png) only.'
    const result = await mirrorBodyHulyToGitlab(deps, body, 42)
    expect(result).toBe(body)
  })

  it('falls back to original link when mirror returns null', async () => {
    const col = makeMirrorCol()
    const gitlabClient: AttachmentGitLabClient = {
      downloadUpload: jest.fn(),
      uploadFile: jest.fn(async () => { throw new Error('upload failed') })
    }
    const hulyStore = makeHulyStore()
    const deps: MirrorDeps = { gitlabClient, hulyStore, mirrorCol: col, logger: makeLogger() }

    const body = '![file](attachments://ref-fail)'
    const result = await mirrorBodyHulyToGitlab(deps, body, 42)
    expect(result).toBe(body)
  })
})
