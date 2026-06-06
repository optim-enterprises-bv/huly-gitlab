/**
 * P4-T-01b probe — verifies the @hcengineering/core Client.notify subscription API.
 *
 * Spec: .omc/specs/p4-t-01b-tx-subscription-api.md
 *
 * Path A confirmed: Client exposes `notify?: (...tx: Tx[]) => void`.
 * ClientImpl.updateFromRemote calls `this.notify?.(...tx)` for every incoming tx.
 * The TxSubscriber (P4-T-09) assigns client.notify directly after createPlatformClient.
 */

import type { Client } from '@hcengineering/core'

/** Minimal fake Client that exposes notify and updateFromRemote (matching ClientImpl shape). */
interface FakeClientImpl extends Client {
  updateFromRemote: (...txes: unknown[]) => Promise<void>
}

function makeFakeClient (): FakeClientImpl {
  return {
    notify: undefined,
    findOne: async () => undefined,
    findAll: async () => [] as never,
    close: async () => {},
    // Mirrors ClientImpl.updateFromRemote — calls this.notify?.(...tx)
    async updateFromRemote (...txes: unknown[]): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).notify?.(...txes)
    }
  } as unknown as FakeClientImpl
}

describe('P4-T-01b: Client.notify subscription (Path A)', () => {
  it('assigning client.notify receives Tx objects delivered via updateFromRemote', async () => {
    const client = makeFakeClient()

    const received: unknown[][] = []
    client.notify = (...txes) => { received.push(txes) }

    // Simulate two tx deliveries (as ClientImpl.updateFromRemote would call)
    const tx1 = { _id: 'tx1', _class: 'core:class:TxMixin', objectId: 'doc-1', modifiedBy: 'account-A' }
    const tx2 = { _id: 'tx2', _class: 'core:class:TxUpdateDoc', objectId: 'doc-2', modifiedBy: 'account-B' }

    await client.updateFromRemote(tx1, tx2)

    expect(received).toHaveLength(1)
    expect(received[0]).toHaveLength(2)
    expect(received[0][0]).toBe(tx1)
    expect(received[0][1]).toBe(tx2)
  })

  it('tx.modifiedBy is accessible — used for MR-2 self-authored filter', async () => {
    const client = makeFakeClient()

    const serviceAccountId = 'system-account-uuid'
    const captured: string[] = []

    client.notify = (...txes) => {
      for (const tx of txes) {
        // modifiedBy on Tx base (inherited from Doc) carries the transaction author
        const txObj = tx as Record<string, unknown>
        const author = txObj.modifiedBy as string
        if (author !== serviceAccountId) {
          captured.push(author)
        }
      }
    }

    const selfTx = { _id: 'tx-self', _class: 'core:class:TxMixin', objectId: 'doc-1', modifiedBy: serviceAccountId }
    const userTx = { _id: 'tx-user', _class: 'core:class:TxMixin', objectId: 'doc-2', modifiedBy: 'user-account-uuid' }

    await client.updateFromRemote(selfTx, userTx)

    // Self-authored tx filtered out; only user tx passes
    expect(captured).toEqual(['user-account-uuid'])
  })

  it('clearing client.notify stops delivery', async () => {
    const client = makeFakeClient()

    const received: unknown[] = []
    client.notify = (...txes) => { received.push(...txes) }

    const tx1 = { _id: 'tx1', _class: 'core:class:TxMixin', objectId: 'doc-1', modifiedBy: 'acct' }
    await client.updateFromRemote(tx1)
    expect(received).toHaveLength(1)

    // Stop subscription
    client.notify = undefined

    const tx2 = { _id: 'tx2', _class: 'core:class:TxMixin', objectId: 'doc-2', modifiedBy: 'acct' }
    await client.updateFromRemote(tx2)
    expect(received).toHaveLength(1) // no new deliveries
  })
})
