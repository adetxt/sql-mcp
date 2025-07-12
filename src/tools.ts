import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Sequelize } from 'sequelize'
import { z } from 'zod'

export async function registerTools(server: McpServer, enableWriteOperations: boolean) {
  server.registerTool(
    'get_tables',
    {
      title: 'Get Tables',
      description: 'Get list of table in database',
      inputSchema: {
        db_type: z.enum(['postgres', 'mysql', 'sqlite']),
        connection_string: z.string(),
      },
    },
    async ({db_type, connection_string}) => {
      const sequelize = new Sequelize(connection_string, {
        dialect: db_type,
      })

      let result: any[] = []
      let tables: string[] = []
      
      switch (db_type) {
        case 'postgres':
          [result] = await sequelize.query('SELECT * FROM information_schema.tables')
          tables = result
            .filter((table: any) => table.table_schema !== 'information_schema' && table.table_schema !== 'pg_catalog')
            .map((table: any) => `${table.table_schema}.${table.table_name}`)
          break
        case 'mysql':
          [result] = await sequelize.query('SELECT * FROM information_schema.tables')
          tables = result.map((table: any) => table.table_name)
          break
        case 'sqlite':
          [result] = await sequelize.query('SELECT * FROM sqlite_master WHERE type = "table"')
          tables = result.map((table: any) => table.name)
          break
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(tables),
          }
        ],
      }
    },
  )
  server.registerTool(
    'get_columns',
    {
      title: 'Get Columns',
      description: 'Get list of column in a table',
      inputSchema: {
        db_type: z.enum(['postgres', 'mysql', 'sqlite']),
        connection_string: z.string(),
        table_name: z.string(),
      },  
    },
    async ({db_type, connection_string, table_name}) => {
      const sequelize = new Sequelize(connection_string, {
        dialect: db_type,
      })

      let result: any[] = []
      let columns: {
        name: string,
        type: string,
        nullable: string,
        default: string,
        key: string,
        extra: string,
      }[] = []

      switch (db_type) {
        case 'postgres':
          [result] = await sequelize.query(`SELECT * FROM information_schema.columns WHERE table_name = '${table_name}'`)
          columns = result.map((column: any) => ({
            name: column.column_name,
            type: column.data_type,
            nullable: column.is_nullable,
            default: column.column_default,
            key: column.column_key,
            extra: column.extra,
          }))
          break
        case 'mysql':
          [result] = await sequelize.query(`SELECT * FROM information_schema.columns WHERE table_name = '${table_name}'`)
          columns = result.map((column: any) => ({
            name: column.column_name,
            type: column.data_type,
            nullable: column.is_nullable,
            default: column.column_default,
            key: column.column_key,
            extra: column.extra,
          }))
          break
        case 'sqlite':
          [result] = await sequelize.query(`SELECT * FROM sqlite_master WHERE type = "table" AND name = '${table_name}'`)
          columns = result.map((column: any) => ({
            name: column.name,
            type: column.type,
            nullable: column.nullable,
            default: column.default,
            key: column.key,
            extra: column.extra,
          }))
          break
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(columns),
          }
        ],
      }
    },
  )
  server.registerTool(
    'execute_query',
    {
      title: 'Execute Query',
      description: 'Run a query to database',
      inputSchema: {
        db_type: z.enum(['postgres', 'mysql', 'sqlite']), 
        connection_string: z.string(),
        query: z.string(),
      },
    },
    async ({db_type, connection_string, query}) => {
      const sequelize = new Sequelize(connection_string, {
        dialect: db_type,
      })

      if (!enableWriteOperations) {
        const writeOperations = ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP']
        if (writeOperations.some((operation) => query.toUpperCase().includes(operation))) {
          throw new Error('Write operations are not enabled')
        }
      }

      const [results] = await sequelize.query(query)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(results),
          }
        ],
      }
    },
  )
}
