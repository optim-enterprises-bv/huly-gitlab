import type { Doc, Ref, Space, TxOperations, WorkspaceUuid } from '@hcengineering/core'
import type { Logger } from '../../src/logging'
import { createHulyAttachmentStore, validateFilename } from '../../src/sync/huly-attachment-store'
import { MAX_ATTACHMENT_BYTES } from '../../src/sync/attachment-links'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger (): Logger {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}

interface FakeDoc extends Doc {
  [key: string]: unknown
}

function makeTxOperations (storedDocs: FakeDoc[] = []): TxOperations {
  return {
    createDoc: jest.fn(async <T extends Doc>(
      _class: Ref<never>,
      _space: Ref<Space>,
      attrs: Partial<T>
    ): Promise<Ref<T>> => {
      const id = `fake-ref-${storedDocs.length}` as Ref<T>
      storedDocs.push({ _id: id, _class, space: _space, modifiedOn: 0, modifiedBy: '' as Ref<Doc>, ...attrs } as unknown as FakeDoc)
      return id
    }),
    findOne: jest.fn(async <T extends Doc>(
      _class: Ref<never>,
      query: Partial<T>
    ): Promise<T | undefined> => {
      return storedDocs.find((d) => d._id === query._id) as T | undefined
    }),
    findAll: jest.fn(async () => []),
    close: jest.fn(async () => {})
  } as unknown as TxOperations
}

const WORKSPACE = 'ws-test' as WorkspaceUuid

// ---------------------------------------------------------------------------
// validateFilename
// ---------------------------------------------------------------------------

describe('validateFilename', () => {
  it('accepts normal filenames', () => {
    expect(() => validateFilename('image.png')).not.toThrow()
    expect(() => validateFilename('my-file_v2.tar.gz')).not.toThrow()
    expect(() => validateFilename('file with spaces.txt')).not.toThrow()
  })

  it('rejects empty string', () => {
    expect(() => validateFilename('')).toThrow('must not be empty')
  })

  it('rejects filename with forward slash', () => {
    expect(() => validateFilename('path/to/file.png')).toThrow('path separators')
  })

  it('rejects filename with backslash', () => {
    expect(() => validateFilename('path\\file.png')).toThrow('path separators')
  })

  it('rejects filename with null byte', () => {
    expect(() => validateFilename('file\0.png')).toThrow('null bytes')
  })
})

// ---------------------------------------------------------------------------
// createHulyAttachmentStore — upload
// ---------------------------------------------------------------------------

describe('createHulyAttachmentStore — upload', () => {
  it('calls createDoc and returns ref + url', async () => {
    const docs: FakeDoc[] = []
    const client = makeTxOperations(docs)
    const store = createHulyAttachmentStore({ client, logger: makeLogger(), workspaceUuid: WORKSPACE })

    const bytes = Buffer.from('hello world')
    const result = await store.upload('hello.txt', bytes)

    expect(result.ref).toMatch(/fake-ref-/)
    expect(result.url).toBe(`attachments://${result.ref}`)
    expect(client.createDoc).toHaveBeenCalledTimes(1)

    const [, , attrs] = (client.createDoc as jest.Mock).mock.calls[0] as [unknown, unknown, Record<string, unknown>]
    expect(attrs.filename).toBe('hello.txt')
    expect(attrs.data).toBe(bytes.toString('base64'))
    expect(attrs.size).toBe(bytes.byteLength)
  })

  it('rejects oversized content', async () => {
    const client = makeTxOperations()
    const store = createHulyAttachmentStore({ client, logger: makeLogger(), workspaceUuid: WORKSPACE })
    const bigBytes = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0)

    await expect(store.upload('big.bin', bigBytes)).rejects.toThrow('byte limit')
    expect(client.createDoc).not.toHaveBeenCalled()
  })

  it('rejects filename with path separator', async () => {
    const client = makeTxOperations()
    const store = createHulyAttachmentStore({ client, logger: makeLogger(), workspaceUuid: WORKSPACE })

    await expect(store.upload('../evil.png', Buffer.from('x'))).rejects.toThrow('path separators')
    expect(client.createDoc).not.toHaveBeenCalled()
  })

  it('rejects empty filename', async () => {
    const client = makeTxOperations()
    const store = createHulyAttachmentStore({ client, logger: makeLogger(), workspaceUuid: WORKSPACE })

    await expect(store.upload('', Buffer.from('x'))).rejects.toThrow('must not be empty')
  })
})

// ---------------------------------------------------------------------------
// createHulyAttachmentStore — download
// ---------------------------------------------------------------------------

describe('createHulyAttachmentStore — download', () => {
  it('fetches doc by ref and decodes base64 bytes', async () => {
    const original = Buffer.from('test-bytes')
    const docs: FakeDoc[] = []
    const client = makeTxOperations(docs)
    const store = createHulyAttachmentStore({ client, logger: makeLogger(), workspaceUuid: WORKSPACE })

    const { ref } = await store.upload('test.txt', original)
    const downloaded = await store.download(ref)

    expect(downloaded).toEqual(original)
    expect(client.findOne).toHaveBeenCalledTimes(1)
  })

  it('accepts attachments:// url prefix and strips it', async () => {
    const original = Buffer.from('url-prefix-test')
    const docs: FakeDoc[] = []
    const client = makeTxOperations(docs)
    const store = createHulyAttachmentStore({ client, logger: makeLogger(), workspaceUuid: WORKSPACE })

    const { url } = await store.upload('test.txt', original)
    const downloaded = await store.download(url)

    expect(downloaded).toEqual(original)
  })

  it('throws when doc not found', async () => {
    const client = makeTxOperations()
    const store = createHulyAttachmentStore({ client, logger: makeLogger(), workspaceUuid: WORKSPACE })

    await expect(store.download('nonexistent-ref')).rejects.toThrow('doc not found')
  })
})

// ---------------------------------------------------------------------------
// idempotency (handled by attachment_mirror layer, not the store itself)
// — the store always creates a new doc on upload; dedup is upstream
// ---------------------------------------------------------------------------

describe('createHulyAttachmentStore — round-trip', () => {
  it('upload then download returns identical bytes', async () => {
    const docs: FakeDoc[] = []
    const client = makeTxOperations(docs)
    const store = createHulyAttachmentStore({ client, logger: makeLogger(), workspaceUuid: WORKSPACE })

    const content = Buffer.from('round-trip content')
    const { ref } = await store.upload('round-trip.txt', content)
    const result = await store.download(ref)

    expect(result).toEqual(content)
  })

  it('handles binary content (non-UTF8 bytes)', async () => {
    const docs: FakeDoc[] = []
    const client = makeTxOperations(docs)
    const store = createHulyAttachmentStore({ client, logger: makeLogger(), workspaceUuid: WORKSPACE })

    const binary = Buffer.from([0x00, 0xff, 0xfe, 0xab, 0xcd, 0x01])
    const { ref } = await store.upload('binary.bin', binary)
    const result = await store.download(ref)

    expect(result).toEqual(binary)
  })
})
