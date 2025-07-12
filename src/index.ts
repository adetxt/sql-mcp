import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { getServer } from './server'

const server = getServer()
const transport = new StdioServerTransport()
server.connect(transport)
