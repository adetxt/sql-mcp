import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Sequelize, QueryTypes } from 'sequelize'
import { z } from 'zod'
import { detectDockerDatabases, detectProjectDatabases } from './detector.js'

const DB_TYPE = z.enum(['postgres', 'mysql', 'sqlite'])
type DbType = z.infer<typeof DB_TYPE>

const WRITE_OP_PATTERN = /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|REPLACE|GRANT|REVOKE)\b/i

function makeSequelize(dbType: DbType, connectionString: string): Sequelize {
  return new Sequelize(connectionString, { dialect: dbType, logging: false })
}

// Table name safety: only word chars and dots (schema.table)
function assertSafeIdentifier(name: string): void {
  if (!/^[\w.]+$/.test(name)) throw new Error(`Unsafe identifier: "${name}"`)
}

export async function registerTools(server: McpServer, enableWriteOperations: boolean) {
  server.registerTool(
    'detect_databases',
    {
      title: 'Detect Databases',
      description:
        'Auto-detect available databases from running Docker containers and project config files ' +
        '(.env, docker-compose.yml, prisma/schema.prisma). Use this first to discover what databases ' +
        'are available before asking the user for a connection string.',
      inputSchema: {
        project_path: z
          .string()
          .optional()
          .describe('Absolute path to the project root to scan. Defaults to current working directory.'),
      },
    },
    async ({ project_path }) => {
      const root = project_path ?? process.cwd()
      const running = detectDockerDatabases()
      const fromProject = detectProjectDatabases(root)

      const all = [...running, ...fromProject]

      if (all.length === 0) {
        return {
          content: [{ type: 'text', text: 'No databases detected. Provide a connection string manually.' }],
        }
      }

      const formatted = all.map((db, i) => ({
        index: i + 1,
        label: db.label,
        source: db.source,
        type: db.type,
        connection_string: db.connection_string,
      }))

      return {
        content: [{ type: 'text', text: JSON.stringify(formatted, null, 2) }],
      }
    },
  )

  server.registerTool(
    'get_tables',
    {
      title: 'Get Tables',
      description: 'List all tables in a database',
      inputSchema: {
        db_type: DB_TYPE,
        connection_string: z.string(),
      },
    },
    async ({ db_type, connection_string }) => {
      const sequelize = makeSequelize(db_type, connection_string)
      let tables: string[] = []

      try {
        switch (db_type) {
          case 'postgres': {
            const rows = await sequelize.query<{ table_schema: string; table_name: string }>(
              `SELECT table_schema, table_name
               FROM information_schema.tables
               WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
               ORDER BY table_schema, table_name`,
              { type: QueryTypes.SELECT },
            )
            tables = rows.map((r) => `${r.table_schema}.${r.table_name}`)
            break
          }
          case 'mysql': {
            const rows = await sequelize.query<{ TABLE_NAME: string }>(
              `SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`,
              { type: QueryTypes.SELECT },
            )
            tables = rows.map((r) => r.TABLE_NAME)
            break
          }
          case 'sqlite': {
            const rows = await sequelize.query<{ name: string }>(
              `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
              { type: QueryTypes.SELECT },
            )
            tables = rows.map((r) => r.name)
            break
          }
        }
      } finally {
        await sequelize.close()
      }

      return { content: [{ type: 'text', text: JSON.stringify(tables) }] }
    },
  )

  server.registerTool(
    'get_columns',
    {
      title: 'Get Columns',
      description: 'Get column definitions for a specific table',
      inputSchema: {
        db_type: DB_TYPE,
        connection_string: z.string(),
        table_name: z.string(),
      },
    },
    async ({ db_type, connection_string, table_name }) => {
      assertSafeIdentifier(table_name)
      const sequelize = makeSequelize(db_type, connection_string)

      type Column = { name: string; type: string; nullable: string; default: string | null; key: string; extra: string }
      let columns: Column[] = []

      try {
        switch (db_type) {
          case 'postgres': {
            // table_name may include schema prefix (e.g. "public.users")
            const [schema, tbl] = table_name.includes('.') ? table_name.split('.', 2) : ['public', table_name]
            const rows = await sequelize.query<any>(
              `SELECT column_name, data_type, is_nullable, column_default, ''::text AS column_key, ''::text AS extra
               FROM information_schema.columns
               WHERE table_schema = :schema AND table_name = :tbl
               ORDER BY ordinal_position`,
              { type: QueryTypes.SELECT, replacements: { schema, tbl } },
            )
            columns = rows.map((r) => ({
              name: r.column_name,
              type: r.data_type,
              nullable: r.is_nullable,
              default: r.column_default,
              key: r.column_key,
              extra: r.extra,
            }))
            break
          }
          case 'mysql': {
            const rows = await sequelize.query<any>(
              `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA
               FROM information_schema.columns
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :tbl
               ORDER BY ORDINAL_POSITION`,
              { type: QueryTypes.SELECT, replacements: { tbl: table_name } },
            )
            columns = rows.map((r) => ({
              name: r.COLUMN_NAME,
              type: r.DATA_TYPE,
              nullable: r.IS_NULLABLE,
              default: r.COLUMN_DEFAULT,
              key: r.COLUMN_KEY,
              extra: r.EXTRA,
            }))
            break
          }
          case 'sqlite': {
            // PRAGMA doesn't support bound params but identifier is sanitized above
            const rows = await sequelize.query<any>(
              `PRAGMA table_info(${table_name})`,
              { type: QueryTypes.SELECT },
            )
            columns = rows.map((r) => ({
              name: r.name,
              type: r.type,
              nullable: r.notnull === 0 ? 'YES' : 'NO',
              default: r.dflt_value,
              key: r.pk ? 'PRI' : '',
              extra: '',
            }))
            break
          }
        }
      } finally {
        await sequelize.close()
      }

      return { content: [{ type: 'text', text: JSON.stringify(columns) }] }
    },
  )

  server.registerTool(
    'execute_query',
    {
      title: 'Execute Query',
      description: 'Run a SQL query against the database',
      inputSchema: {
        db_type: DB_TYPE,
        connection_string: z.string(),
        query: z.string(),
      },
    },
    async ({ db_type, connection_string, query }) => {
      if (!enableWriteOperations && WRITE_OP_PATTERN.test(query)) {
        throw new Error(
          'Write operations are disabled. Start the server with --enable-write-operations to allow them.',
        )
      }

      const sequelize = makeSequelize(db_type, connection_string)
      let results: unknown

      try {
        ;[results] = await sequelize.query(query)
      } finally {
        await sequelize.close()
      }

      return { content: [{ type: 'text', text: JSON.stringify(results) }] }
    },
  )
}
