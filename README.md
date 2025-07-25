# SQL MCP Server

A Model Context Protocol (MCP) server implementation for SQL databases, providing a standardized interface for interacting with SQL databases through the MCP protocol.

<a href="https://glama.ai/mcp/servers/@adetxt/sql-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@adetxt/sql-mcp/badge" alt="SQL Server MCP server" />
</a>

## Installation

<details>
<summary><b>Install in Widsurf</b></summary>

```json
{
  "mcpServers": {
    "sql-mcp": {
      "command": "npx",
      "args": ["@adetxt/sql-mcp"]
    }
  }
}
```
</details>

<details>
<summary><b>Install in Cursor</b></summary>

```json
{
  "mcpServers": {
    "sql-mcp": {
      "command": "npx",
      "args": ["@adetxt/sql-mcp"]
    }
  }
}
```
</details>

<details>
<summary><b>Install in VS Code</b></summary>

```json
{
  "mcp": {
    "servers": {
      "sql-mcp": {
        "type": "stdio",
        "command": "npx",
        "args": ["@adetxt/sql-mcp"]
    }
  }
}
```
</details>

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For support, please open an issue in the [GitHub repository](https://github.com/adetxt/sql-mcp/issues).