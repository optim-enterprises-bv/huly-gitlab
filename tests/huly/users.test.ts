import { UserIdentity } from '../../src/huly/users'
import type { IdMapStore, SyncUser } from '../../src/huly/users'
import type { PersonUuid, WorkspaceUuid } from '@hcengineering/core'

// Minimal AccountClient stub — only the method UserIdentity uses
interface AccountClientStub {
  findPersonBySocialKey: jest.Mock<Promise<PersonUuid | undefined>, [string]>
}

function makeAccountClient (): AccountClientStub {
  return {
    findPersonBySocialKey: jest.fn()
  }
}

function makeStore (): jest.Mocked<IdMapStore> {
  return {
    getIdMap: jest.fn(),
    putIdMap: jest.fn()
  }
}

const WS = 'ws-uuid-test' as WorkspaceUuid
const PERSON_A = 'person-uuid-aaa' as PersonUuid

describe('UserIdentity', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  // 1. mapByEmail found
  it('mapByEmail returns PersonUuid when account found', async () => {
    const ac = makeAccountClient()
    ac.findPersonBySocialKey.mockResolvedValue(PERSON_A)
    const store = makeStore()
    const ui = new UserIdentity(ac as never, store, WS)

    const result = await ui.mapByEmail('User@Example.Com')
    expect(result).toBe(PERSON_A)
    expect(ac.findPersonBySocialKey).toHaveBeenCalledWith('email:user@example.com')
  })

  // 2. mapByEmail missing → undefined
  it('mapByEmail returns undefined when not found', async () => {
    const ac = makeAccountClient()
    ac.findPersonBySocialKey.mockResolvedValue(undefined)
    const store = makeStore()
    const ui = new UserIdentity(ac as never, store, WS)

    const result = await ui.mapByEmail('nobody@example.com')
    expect(result).toBeUndefined()
  })

  // 3. mapByGitlabUser found by gitlab:id
  it('mapByGitlabUser returns PersonUuid found by gitlab social key', async () => {
    const ac = makeAccountClient()
    ac.findPersonBySocialKey.mockResolvedValue(PERSON_A)
    const store = makeStore()
    const ui = new UserIdentity(ac as never, store, WS)
    const user: SyncUser = { gitlabId: '42', email: 'a@b.com' }

    const result = await ui.mapByGitlabUser(user)
    expect(result).toBe(PERSON_A)
    expect(ac.findPersonBySocialKey).toHaveBeenCalledWith('gitlab:42')
    // Should NOT have fallen back to email lookup
    expect(ac.findPersonBySocialKey).toHaveBeenCalledTimes(1)
  })

  // 4. mapByGitlabUser falls back to email
  it('mapByGitlabUser falls back to email when gitlab key misses', async () => {
    const ac = makeAccountClient()
    ac.findPersonBySocialKey
      .mockResolvedValueOnce(undefined) // gitlab:99
      .mockResolvedValueOnce(PERSON_A)  // email:fallback@example.com
    const store = makeStore()
    const ui = new UserIdentity(ac as never, store, WS)
    const user: SyncUser = { gitlabId: '99', email: 'fallback@example.com' }

    const result = await ui.mapByGitlabUser(user)
    expect(result).toBe(PERSON_A)
    expect(ac.findPersonBySocialKey).toHaveBeenCalledWith('gitlab:99')
    expect(ac.findPersonBySocialKey).toHaveBeenCalledWith('email:fallback@example.com')
  })

  // 5. mapByGitlabUser returns undefined when both miss
  it('mapByGitlabUser returns undefined when both gitlab and email miss', async () => {
    const ac = makeAccountClient()
    ac.findPersonBySocialKey.mockResolvedValue(undefined)
    const store = makeStore()
    const ui = new UserIdentity(ac as never, store, WS)
    const user: SyncUser = { gitlabId: '7', email: 'ghost@example.com' }

    const result = await ui.mapByGitlabUser(user)
    expect(result).toBeUndefined()
  })

  // 6. ensureStubGuest returns existing stub from idMap (R9 dedup)
  it('ensureStubGuest returns existing stub without creating new one', async () => {
    const ac = makeAccountClient()
    const store = makeStore()
    store.getIdMap.mockResolvedValue('stub:gitlab:55')
    const ui = new UserIdentity(ac as never, store, WS)
    const user: SyncUser = { gitlabId: '55' }

    const result = await ui.ensureStubGuest(user)
    expect(result).toBe('stub:gitlab:55')
    expect(store.putIdMap).not.toHaveBeenCalled()
  })

  // 7. ensureStubGuest creates new stub when missing
  it('ensureStubGuest creates and stores stub when not in idMap', async () => {
    const ac = makeAccountClient()
    const store = makeStore()
    store.getIdMap.mockResolvedValue(undefined)
    store.putIdMap.mockResolvedValue(undefined)
    const ui = new UserIdentity(ac as never, store, WS)
    const user: SyncUser = { gitlabId: '77' }

    const result = await ui.ensureStubGuest(user)
    expect(result).toBe('stub:gitlab:77')
    expect(store.putIdMap).toHaveBeenCalledWith(WS, 'user', '77', 'stub:gitlab:77')
  })

  // 8. Cache hit within TTL — accountClient called once
  it('cache hit within TTL: accountClient called only once', async () => {
    const ac = makeAccountClient()
    ac.findPersonBySocialKey.mockResolvedValue(PERSON_A)
    const store = makeStore()
    const ui = new UserIdentity(ac as never, store, WS, 60000)

    await ui.mapByEmail('cached@example.com')
    await ui.mapByEmail('cached@example.com')

    expect(ac.findPersonBySocialKey).toHaveBeenCalledTimes(1)
  })

  // 9. Cache TTL expiry — accountClient called again
  it('cache miss after TTL expiry: accountClient called again', async () => {
    jest.useFakeTimers()
    const ac = makeAccountClient()
    ac.findPersonBySocialKey.mockResolvedValue(PERSON_A)
    const store = makeStore()
    const ui = new UserIdentity(ac as never, store, WS, 5000)

    await ui.mapByEmail('ttl@example.com')
    expect(ac.findPersonBySocialKey).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(6000)

    await ui.mapByEmail('ttl@example.com')
    expect(ac.findPersonBySocialKey).toHaveBeenCalledTimes(2)
  })

  // 10. invalidate() clears cache
  it('invalidate() causes next call to re-fetch from accountClient', async () => {
    const ac = makeAccountClient()
    ac.findPersonBySocialKey.mockResolvedValue(PERSON_A)
    const store = makeStore()
    const ui = new UserIdentity(ac as never, store, WS, 60000)

    await ui.mapByEmail('inv@example.com')
    expect(ac.findPersonBySocialKey).toHaveBeenCalledTimes(1)

    ui.invalidate()

    await ui.mapByEmail('inv@example.com')
    expect(ac.findPersonBySocialKey).toHaveBeenCalledTimes(2)
  })
})
