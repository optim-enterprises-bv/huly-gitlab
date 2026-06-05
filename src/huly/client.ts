import clientPlugin from '@hcengineering/client'
import clientResources from '@hcengineering/client-resources'
import { type Client, type MeasureContext, type WorkspaceUuid } from '@hcengineering/core'
import { setMetadata } from '@hcengineering/platform'
import { getTransactorEndpoint } from '@hcengineering/server-client'
import { generateToken, systemAccountUuid } from '@hcengineering/server-token'

export async function createPlatformClient (
  ctx: MeasureContext,
  workspaceUuid: WorkspaceUuid,
  timeout: number
): Promise<{ client: Client, endpoint: string }> {
  setMetadata(clientPlugin.metadata.UseBinaryProtocol, true)
  setMetadata(clientPlugin.metadata.UseProtocolCompression, true)
  setMetadata(clientPlugin.metadata.ConnectionTimeout, timeout)
  setMetadata(clientPlugin.metadata.FilterModel, 'client')

  const token = generateToken(systemAccountUuid, workspaceUuid, { service: 'gitlab', mode: 'gitlab' })
  const endpoint = await getTransactorEndpoint(token)
  const factory = await clientResources()
  const connection = await factory.function.GetClient(token, endpoint, {
    ctx,
    useGlobalRPCHandler: true
  })

  return { client: connection, endpoint }
}

export async function closePlatformClient (client: Client): Promise<void> {
  await client.close()
}
