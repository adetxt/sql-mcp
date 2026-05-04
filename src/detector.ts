import { execSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'

export type DbType = 'postgres' | 'mysql' | 'sqlite'

export interface DetectedDatabase {
  type: DbType
  connection_string: string
  source: 'docker_running' | 'docker_compose' | 'env_file' | 'prisma'
  label: string
}

function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let val = trimmed.slice(eqIdx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    vars[key] = val
  }
  return vars
}

function dialectFromUrl(url: string): DbType | null {
  const lower = url.toLowerCase()
  if (lower.startsWith('postgres') || lower.startsWith('postgresql')) return 'postgres'
  if (lower.startsWith('mysql') || lower.startsWith('mariadb')) return 'mysql'
  if (lower.startsWith('sqlite')) return 'sqlite'
  return null
}

function dialectFromImage(image: string): { type: DbType; defaultPort: number } | null {
  const lower = image.toLowerCase().split(':')[0]
  if (lower.includes('postgres')) return { type: 'postgres', defaultPort: 5432 }
  if (lower.includes('mysql') || lower.includes('mariadb')) return { type: 'mysql', defaultPort: 3306 }
  return null
}

function buildConnectionString(
  type: DbType,
  user: string,
  password: string,
  host: string,
  port: number,
  database: string,
): string {
  const proto = type === 'postgres' ? 'postgres' : 'mysql'
  const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : encodeURIComponent(user)
  return `${proto}://${auth}@${host}:${port}/${database}`
}

export function detectDockerDatabases(): DetectedDatabase[] {
  const results: DetectedDatabase[] = []

  let psOutput: string
  try {
    psOutput = execSync(
      `docker ps --format '{"id":"{{.ID}}","image":"{{.Image}}","ports":"{{.Ports}}","names":"{{.Names}}"}'`,
      { encoding: 'utf8', timeout: 5000 },
    )
  } catch {
    return []
  }

  for (const line of psOutput.trim().split('\n')) {
    if (!line.trim()) continue
    let container: { id: string; image: string; ports: string; names: string }
    try {
      container = JSON.parse(line)
    } catch {
      continue
    }

    const dbInfo = dialectFromImage(container.image)
    if (!dbInfo) continue

    // Parse first host port mapped to the db default port
    let hostPort = dbInfo.defaultPort
    const portRegex = /(?:0\.0\.0\.0|::):(\d+)->/g
    let portMatch: RegExpExecArray | null
    while ((portMatch = portRegex.exec(container.ports)) !== null) {
      hostPort = parseInt(portMatch[1], 10)
      break
    }

    // Inspect container env for credentials
    let user = dbInfo.type === 'postgres' ? 'postgres' : 'root'
    let password = ''
    let database = dbInfo.type === 'postgres' ? 'postgres' : ''

    try {
      const envJson = execSync(
        `docker inspect ${container.id} --format '{{json .Config.Env}}'`,
        { encoding: 'utf8', timeout: 5000 },
      )
      const envList: string[] = JSON.parse(envJson.trim())
      const env: Record<string, string> = {}
      for (const entry of envList) {
        const idx = entry.indexOf('=')
        if (idx !== -1) env[entry.slice(0, idx)] = entry.slice(idx + 1)
      }

      if (dbInfo.type === 'postgres') {
        if (env['POSTGRES_USER']) user = env['POSTGRES_USER']
        password = env['POSTGRES_PASSWORD'] || env['PGPASSWORD'] || ''
        database = env['POSTGRES_DB'] || user
      } else {
        password = env['MYSQL_ROOT_PASSWORD'] || env['MYSQL_PASSWORD'] || ''
        database = env['MYSQL_DATABASE'] || ''
        if (env['MYSQL_USER'] && env['MYSQL_PASSWORD']) {
          user = env['MYSQL_USER']
          password = env['MYSQL_PASSWORD']
        }
      }
    } catch {
      // best-effort
    }

    results.push({
      type: dbInfo.type,
      connection_string: buildConnectionString(dbInfo.type, user, password, 'localhost', hostPort, database),
      source: 'docker_running',
      label: `Running container: ${container.names} (${container.image})`,
    })
  }

  return results
}

type ServiceBlock = {
  name: string
  image: string
  ports: string[]
  env: Record<string, string>
}

function parseDockerComposeServices(yaml: string): ServiceBlock[] {
  const services: ServiceBlock[] = []
  const lines = yaml.split('\n')

  let inServices = false
  let current: ServiceBlock | null = null
  let section: 'none' | 'ports' | 'env' = 'none'

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const indent = raw.length - raw.trimStart().length

    if (indent === 0) {
      if (trimmed === 'services:') { inServices = true; continue }
      if (inServices) {
        if (current) { services.push(current); current = null }
        inServices = false
        continue
      }
    }

    if (!inServices) continue

    if (indent === 2 && !trimmed.startsWith('-') && trimmed.endsWith(':')) {
      if (current) services.push(current)
      current = { name: trimmed.slice(0, -1), image: '', ports: [], env: {} }
      section = 'none'
      continue
    }

    if (!current) continue

    if (indent === 4) {
      if (trimmed.startsWith('image:')) {
        current.image = trimmed.slice('image:'.length).trim().replace(/^['"]|['"]$/g, '')
        section = 'none'
      } else if (trimmed === 'ports:') {
        section = 'ports'
      } else if (trimmed === 'environment:') {
        section = 'env'
      } else {
        section = 'none'
      }
      continue
    }

    if (indent >= 6) {
      if (section === 'ports' && trimmed.startsWith('-')) {
        current.ports.push(trimmed.slice(1).trim().replace(/^['"]|['"]$/g, ''))
      } else if (section === 'env') {
        if (trimmed.startsWith('-')) {
          const pair = trimmed.slice(1).trim()
          const idx = pair.indexOf('=')
          if (idx !== -1) current.env[pair.slice(0, idx)] = pair.slice(idx + 1)
        } else {
          const idx = trimmed.indexOf(':')
          if (idx !== -1) {
            current.env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '')
          }
        }
      }
    }
  }

  if (current) services.push(current)
  return services
}

function composeServiceToDb(service: ServiceBlock, sourceFile: string): DetectedDatabase | null {
  const dbInfo = dialectFromImage(service.image)
  if (!dbInfo) return null

  let user = dbInfo.type === 'postgres' ? 'postgres' : 'root'
  let password = ''
  let database = ''

  const { env } = service
  if (dbInfo.type === 'postgres') {
    if (env['POSTGRES_USER']) user = env['POSTGRES_USER']
    password = env['POSTGRES_PASSWORD'] || env['PGPASSWORD'] || ''
    database = env['POSTGRES_DB'] || user
  } else {
    password = env['MYSQL_ROOT_PASSWORD'] || env['MYSQL_PASSWORD'] || ''
    database = env['MYSQL_DATABASE'] || ''
    if (env['MYSQL_USER'] && env['MYSQL_PASSWORD']) {
      user = env['MYSQL_USER']
      password = env['MYSQL_PASSWORD']
    }
  }

  let hostPort = dbInfo.defaultPort
  for (const portDef of service.ports) {
    const parts = portDef.split(':')
    if (parts.length === 2 && parseInt(parts[1]) === dbInfo.defaultPort) {
      hostPort = parseInt(parts[0])
      break
    }
  }

  return {
    type: dbInfo.type,
    connection_string: buildConnectionString(dbInfo.type, user, password, 'localhost', hostPort, database),
    source: 'docker_compose',
    label: `${sourceFile} → service "${service.name}" (${service.image})`,
  }
}

export function detectProjectDatabases(projectPath: string): DetectedDatabase[] {
  const results: DetectedDatabase[] = []
  const root = resolve(projectPath)

  // .env files
  for (const envFile of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    const filePath = join(root, envFile)
    if (!existsSync(filePath)) continue
    try {
      const vars = parseEnvFile(readFileSync(filePath, 'utf8'))
      for (const key of ['DATABASE_URL', 'DB_URL', 'DATABASE_URI', 'DB_URI', 'DB_CONNECTION']) {
        const val = vars[key]
        if (!val) continue
        const type = dialectFromUrl(val)
        if (type) {
          results.push({ type, connection_string: val, source: 'env_file', label: `${envFile} → ${key}` })
        }
      }
    } catch {
      // skip
    }
  }

  // docker-compose files
  for (const composeFile of ['docker-compose.yml', 'docker-compose.yaml', 'docker-compose.dev.yml', 'docker-compose.dev.yaml']) {
    const filePath = join(root, composeFile)
    if (!existsSync(filePath)) continue
    try {
      const services = parseDockerComposeServices(readFileSync(filePath, 'utf8'))
      for (const svc of services) {
        const db = composeServiceToDb(svc, composeFile)
        if (db) results.push(db)
      }
    } catch {
      // skip
    }
  }

  // Prisma schema
  const prismaSchema = join(root, 'prisma', 'schema.prisma')
  if (existsSync(prismaSchema)) {
    try {
      const content = readFileSync(prismaSchema, 'utf8')
      const providerMatch = content.match(/provider\s*=\s*"([^"]+)"/)
      const urlEnvMatch = content.match(/url\s*=\s*env\("([^"]+)"\)/)
      const urlDirectMatch = content.match(/url\s*=\s*"([^"]+)"/)

      if (providerMatch) {
        const type = dialectFromUrl(providerMatch[1]) ?? dialectFromUrl(providerMatch[1] === 'postgresql' ? 'postgres://' : providerMatch[1])
        if (type) {
          if (urlDirectMatch) {
            results.push({ type, connection_string: urlDirectMatch[1], source: 'prisma', label: `prisma/schema.prisma (provider: ${providerMatch[1]})` })
          } else if (urlEnvMatch) {
            results.push({ type, connection_string: `See env var: ${urlEnvMatch[1]}`, source: 'prisma', label: `prisma/schema.prisma (provider: ${providerMatch[1]}, url from $${urlEnvMatch[1]})` })
          }
        }
      }
    } catch {
      // skip
    }
  }

  return results
}
