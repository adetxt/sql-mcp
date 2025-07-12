import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTools } from './tools'
import { program } from 'commander'

program
  .option('--enable-write-operations', 'Enable write operations', false)

program.parse();

const options = program.opts<{
  enableWriteOperations: boolean
}>();

export const getServer = () => {
  const server = new McpServer({
    name: 'sql-mcp',
    version: '1.0.0',
  })

  registerTools(server, options.enableWriteOperations)

  return server
}
