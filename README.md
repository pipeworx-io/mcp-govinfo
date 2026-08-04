# @pipeworx/govinfo

GovInfo.gov MCP — full text of US government publications.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

- `list_collections()`
- `search_packages(query, collections?, congress?, date_from?, date_to?, page_size?, offset_mark?)`
- `get_package(package_id)`
- `list_granules(package_id, page_size?, offset_mark?)`
- `get_granule(package_id, granule_id)`

## Auth

- **Platform key:** reuses `PLATFORM_DATAGOV_KEY`.
- **BYO:** `?_apiKey=<key>` (api.data.gov key).

## Data source

`https://api.govinfo.gov` — `?api_key=` query param.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "govinfo": {
      "url": "https://gateway.pipeworx.io/govinfo/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Govinfo data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
