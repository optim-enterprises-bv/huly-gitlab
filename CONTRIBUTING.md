# Contributing to huly-gitlab

Thank you for contributing to huly-gitlab! This document outlines the development workflow, coding standards, and review process.

## Branch Model

- **main** — Stable, production-ready code. Protected branch requiring code review.
- **feature/** — Feature branches off `main`. Deleted after merge.

**Workflow:**
```bash
git checkout main
git pull origin main
git checkout -b feature/my-feature
# ... make changes ...
git push origin feature/my-feature
# Open Pull Request against main
```

## Commit Style

- **Imperative, present tense:** "Add feature X" not "Added feature X" or "Adds feature X"
- **One logical change per commit** (or per PR if small)
- **Reference issue/task IDs:** "Add OAuth flow (T-09)" or "Fix webhook signature validation (#42)"
- **Example:**
  ```
  Add webhook auto-registration for GitLab projects
  
  - Generates per-binding secret (32 bytes)
  - Subscribes to issues_events and note_events only
  - Filters confidential events at dispatch layer
  
  Fixes #42
  ```

## Required Checks Before PR

All of the following must pass before opening or merging a PR:

```bash
npm run lint
npm run format:check
npm test
```

### Lint

```bash
npm run lint
```

Enforces `eslint-config-love` (TypeScript strict mode). **No `any` types allowed in public APIs.**

**Common fixes:**
```bash
npm run format  # Auto-format code
```

### Format

```bash
npm run format:check
npm test
```

Uses Prettier with:
- `semi: false`
- `singleQuote: true`
- `trailingComma: none`
- `printWidth: 120`

Auto-fix with:
```bash
npm run format
```

### Test

```bash
npm test
```

Runs Jest against `src/**/*.test.ts` and `tests/**/*.test.ts`.

**Coverage expectations:**
- New code ≥ 80% statement coverage
- Critical paths (conflict resolution, encryption) ≥ 95%

## Code Style & Patterns

### TypeScript

- **Strict mode enabled** — all files must compile without errors
- **No `any`** in public APIs; use `unknown` and type guards when necessary
- **Explicit return types** for all functions (inferred only for private helpers)
- **Immutable data structures** preferred; use `readonly` for object properties

**Example:**
```typescript
interface Binding {
  readonly bindingId: string
  readonly workspaceUuid: string
  readonly disabled: boolean
}

export async function getBinding(id: string): Promise<Binding | undefined> {
  // ...
}
```

### HTTP & Fetch

- Prefer **global Node 22 `fetch`** over axios or node-fetch
- Always set timeout and abort signal:
  ```typescript
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
  ```
- Handle `AbortError` separately from network errors

### Encryption

- Use **node:crypto** only (no external crypto libraries)
- AES-256-GCM for sensitive data (tokens, secrets)
- Include IV and auth tag in ciphertext (standard practice)
- Always validate encryption key length at startup

**Example (credentials.ts pattern):**
```typescript
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const key = Buffer.from(config.CredentialEncryptionKey, 'base64')
const iv = randomBytes(16)

const cipher = createCipheriv(ALGORITHM, key, iv)
const ciphertext = Buffer.concat([
  cipher.update(plaintext, 'utf8'),
  cipher.final()
])
const tag = cipher.getAuthTag()
```

### Error Handling

- **Never swallow errors silently** — log or re-throw
- **Structured logging:** use `ctx.log` with correlation ID and context
- **Error messages:** include enough context to debug without logs
  ```typescript
  throw new Error(`Failed to sync issue ${issueRef} in binding ${bindingId}: ${originalError.message}`)
  ```

### Testing

- **Unit tests** for single modules (e.g., config loading, encryption)
- **Integration tests** for module interactions (e.g., adapter + conflict resolver)
- **Use nock for HTTP mocking** (not live calls)
- **Use jest fake timers** for time-dependent code (polling, refresh)
- **Avoid hardcoded UUIDs** — use factories or helpers

**Example (adapter test with nock):**
```typescript
import nock from 'nock'

describe('GitLabClient', () => {
  beforeEach(() => {
    nock('https://gitlab.com')
      .get('/api/v4/projects/1')
      .reply(200, { id: 1, name: 'my-project' })
  })

  it('fetches project by ID', async () => {
    const project = await client.getProject(1)
    expect(project.name).toBe('my-project')
  })
})
```

### Logging

- **Structured logs only** — one JSON object per line
- **Include correlation ID** — trace events across services
- **Levels:** `debug`, `info`, `warn`, `error`
- **Never log plaintext secrets** — redact tokens, keys, etc.

**Example:**
```typescript
ctx.log('info', 'Webhook processed', {
  bindingId,
  eventId,
  eventKind: 'issue',
  duration: Date.now() - startTime
})
```

## Adding a New SyncManager

SyncManagers implement the `SyncManager` interface to handle bidirectional sync for a resource kind (e.g., issues, notes, custom fields in future phases).

**Template:**

```typescript
import { SyncManager, SyncEvent } from '../sync/types'
import { Binding } from '../state/bindings'
import { Store } from '../state/store'

export class MyResourceSyncManager implements SyncManager {
  readonly kind = 'my_resource'

  constructor(private store: Store) {}

  async applyRemote(
    ctx: MeasureContext,
    binding: Binding,
    record: SyncMyResource
  ): Promise<void> {
    // 1. Look up idMap for existing Huly doc
    const existing = await this.store.idMap.findByGitlabId(binding.workspaceUuid, this.kind, record.gitlabId)

    if (!existing) {
      // 2. Create new Huly doc
      const doc = await hulyClient.createDoc(binding.hulyProjectRef, {
        // ... populate from record
      })
      // 3. Upsert idMap
      await this.store.idMap.upsert({
        workspaceUuid: binding.workspaceUuid,
        gitlabKind: this.kind,
        gitlabId: record.gitlabId,
        hulyClass: doc.class,
        hulyRef: doc.ref
      })
    } else {
      // 2. Load cursor and compare timestamps
      const cursor = await this.store.cursors.get(binding._id, this.kind)
      // 3. Apply LWW conflict resolution per field
      // 4. Update Huly doc
      // 5. Advance cursor
    }
  }

  async applyLocal(
    ctx: MeasureContext,
    binding: Binding,
    hulyDoc: any,
    change: Change
  ): Promise<void> {
    // 1. Look up idMap for GitLab ID
    const gitlabId = await this.store.idMap.findByHulyRef(binding.workspaceUuid, hulyDoc.ref)
    if (!gitlabId) {
      // 2a. New Huly doc → create on GitLab
      const created = await gitlabAdapter.create(binding.gitlabProjectId, { /* ... */ })
      await this.store.idMap.upsert(/* ... */)
    } else {
      // 2b. Existing doc → update on GitLab
      await gitlabAdapter.update(binding.gitlabProjectId, gitlabId, { /* ... */ })
    }
  }

  async backfill(
    ctx: MeasureContext,
    binding: Binding,
    since: Date
  ): Promise<void> {
    // 1. Query GitLab API for all resources updated since cursor
    const resources = await gitlabAdapter.listResources(binding.gitlabProjectId, { updatedAfter: since })
    // 2. For each resource, enqueue as remote event
    for (const resource of resources) {
      await engine.enqueueWebhookEvent(binding._id, 'my_resource', resource)
    }
  }
}
```

**Checklist:**
- [ ] Implements `SyncManager` interface
- [ ] `kind` constant matches idMap kind contract
- [ ] Tests cover: create both directions, edit, conflict, dedup
- [ ] Markdown attachment link-through tested (if applicable)
- [ ] Confidential resource filtering tested (if applicable)
- [ ] No `any` types
- [ ] ≥ 80% test coverage

## Code Review Process

**PR expectations:**
1. **Title:** Concise, imperative mood (e.g., "Add webhook registration")
2. **Description:** Problem, solution, testing approach
3. **Linked issues:** Reference task ID or GitHub issue number
4. **Checks passing:** lint, format, test must all pass

**Review checklist (for maintainers):**
- Code follows patterns from existing codebase
- No security issues (no plaintext secrets in logs, proper input validation)
- Tests are meaningful and cover edge cases
- Documentation updated if API/config changed
- No dead code or debug logging left behind

## Pull Request Template

```markdown
## Description
Brief description of what this PR does.

## Related Issue
Fixes #123 or Addresses T-10.

## Approach
How you solved the problem (implementation notes).

## Testing
- Unit tests: describe coverage
- Integration tests: manual steps if not automated
- E2E tests: manual steps if not automated

## Checklist
- [ ] `npm run lint` passes
- [ ] `npm run format:check` passes
- [ ] `npm test` passes
- [ ] New tests added (if applicable)
- [ ] Documentation updated (if API/config changed)
- [ ] No debug logging or `TODO` comments left behind
```

## Useful Commands

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Lint and format
npm run lint
npm run format

# Run tests with coverage
npm test -- --coverage

# Run E2E tests (requires docker compose running)
npm run test:e2e

# Watch mode for development
npm run dev

# Docker build
docker build -t hardcoreeng/huly-gitlab .
```

## Getting Help

- **Questions:** Open a GitHub discussion or issue
- **Security vulnerabilities:** Email security@example.com (do not open public issue)
- **Design discussions:** Refer to `/docs/architecture.md` and `.omc/plans/autopilot-impl.md`

## License

All contributions are licensed under EPL-2.0 (same as the project).
