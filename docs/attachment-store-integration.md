# Attachment Store Integration

## Overview

The bi-directional file mirror (`src/sync/attachments.ts`) mirrors attached files between
GitLab uploads and the Huly platform. The Huly side of the mirror is backed by
`HulyAttachmentStore` — an interface with `upload(filename, bytes)` and `download(ref)`.

## Huly API Used

**Package**: `@hcengineering/core` (v0.7.423)  
**API**: `TxOperations.createDoc` / `TxOperations.findOne`

No `@hcengineering/attachment`, `@hcengineering/storage`, or blob-upload API was found in
the installed package set (v0.7.423). The real platform attachment service API was not
available as a dependency.

The implementation (`src/sync/huly-attachment-store.ts`) stores file bytes as base64-encoded
content inside a synthetic `gitlab:class:AttachmentBlob` doc created via `createDoc`. The
doc `_id` becomes the stable file reference; the URL scheme is `attachments://<_id>`.

## Wiring

`BindingLoader` (`src/sync/binding-loader.ts`) creates a per-workspace `HulyAttachmentStore`
inside `getOrCreateWorkspaceEntry` when `mirrorCol` is provided. At workspace cache creation
time, `createHulyAttachmentStore({ client: txOperations, logger, workspaceUuid })` is called.

`src/index.ts` passes `store.attachmentMirror()` as `mirrorCol` to `BindingLoader`, enabling
mirror wiring for all workspaces. A per-binding `MirrorDeps` is constructed in `loadInternal`
by combining the per-binding `gitlabClient` with the workspace-level `hulyStore`.

The `mirrorDepsRef` mutable cell in `index.ts` is updated by `wrapLoaderWithMirror` on each
`loadBinding` call, before any mirror operation runs in the same async chain. JavaScript's
single-threaded event loop guarantees the update is visible to subsequent mirror operations.

## Fallback Behavior

If `createHulyAttachmentStore` fails at workspace creation time (for example, if the Huly
platform rejects the doc class or the connection is unavailable), the error is caught,
a warning is logged, and `hulyStore` is set to `undefined`. Managers receive `mirrorDeps:
undefined` and fall back to link-through for all attachment URLs — the original GitLab upload
URL passes through unchanged to Huly.

Individual upload/download failures within a sync operation are caught by
`mirrorGitlabUploadToHuly` / `mirrorHulyAttachmentToGitlab`, which return `null` on any error.
The caller (`issues.ts`, `notes.ts`) falls back to link-through and logs
`ATTACHMENT_MIRROR_FAILED`.

Startup is never blocked by attachment store failures.

## Idempotency

Content-hash deduplication is implemented in `src/sync/attachments.ts`:

1. SHA-256 hash of the file bytes is computed before any upload.
2. `findMirroredAttachment(mirrorCol, hash, origin)` checks the `attachment_mirror` collection.
3. If a mapping exists, the cached target URL is returned without re-uploading.
4. On first upload, `insertMirroredAttachment` writes the mapping; a unique index
   `attachment_mirror_hash_origin` on `(contentHash, origin)` makes concurrent inserts safe.

The `HulyAttachmentStore` itself does not deduplicate — it always creates a new doc on each
`upload` call. Deduplication is the responsibility of the mirror layer one level up.

## Filename Validation

`validateFilename` in `huly-attachment-store.ts` rejects:
- Empty strings
- Names containing `/` or `\\` (path traversal)
- Names containing null bytes

## Operational Expectations

- **Platform connectivity**: `TxOperations` must be connected to the Huly transactor for
  upload/download to succeed. If the connection is lost, mirror operations fail gracefully
  with link-through.
- **Doc class**: The `gitlab:class:AttachmentBlob` class is a synthetic identifier not
  registered in the platform model. Depending on platform version, `createDoc` may reject
  unknown classes. If this occurs, all mirror operations will fail gracefully and fall back
  to link-through. A future iteration should register a proper attachment model class.
- **Storage**: Each mirrored file stores ~1.33× its original size (base64 overhead) in the
  Huly document store. The 25 MB cap (`MAX_ATTACHMENT_BYTES`) limits individual file size.
