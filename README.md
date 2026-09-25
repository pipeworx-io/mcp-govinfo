# @pipeworx/govinfo

GovInfo.gov MCP — full text of US government publications.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

- `list_collections()`
- `search_packages(query, collections?, congress?, date_from?, date_to?, page_size?, offset_mark?)`
  - `collections` takes one code or several, comma- or space-separated (`"CHRG"`, `"CHRG,CRPT"`). Several codes search the **union** — `"CHRG,CRPT"` returns 9,239 hits for "Cooper", exactly the 5,359 + 3,880 the two collections return on their own.
  - `page_size` also answers to `limit`.
- `get_package(package_id)`
- `list_granules(package_id, page_size?, offset_mark?)` — `page_size` also answers to `limit`.
- `get_granule(package_id, granule_id)`

## Auth

- **Platform key:** reuses `PLATFORM_DATAGOV_KEY`.
- **BYO:** `?_apiKey=<key>` (api.data.gov key).

## Data source

`https://api.govinfo.gov` — `?api_key=` query param.

## GAO appropriations law (fleet #1972)

Two tools that make GAO's secondary authority reachable by TOPIC rather than by
package id.

### `gao_red_book(topic?, chapter?, include_scope_text?)`

Resolves a fiscal-law question to the governing chapter of GAO's *Principles of
Federal Appropriations Law* — the Red Book. **Keyless**: it reads
`www.gao.gov`, not the GovInfo API, so it works with no data.gov key.

**Why it does not use GovInfo.** Measured 2026-09-14: the `GAOREPORTS`
collection holds 16,569 packages but **zero issued after 2010-01-01**, and a
full-text search for *"Principles of Federal Appropriations Law"* returns
**exactly one relevant package in its top 100 of 1,565 hits** — the *2004 Update
of the Third Edition*. GovInfo cannot serve the current Red Book at all.

**Edition handling is the point.** GAO now publishes the Red Book chapter by
chapter, so the current treatise is a mix:

> *"Our current Red Book consists of Chapters 1-3 (of the 4th Edition) and
> Chapters 5-15 (of the 3rd Edition)."* — gao.gov, read live on every call

That sentence and the whole table of contents are parsed from GAO's page at call
time rather than hardcoded, so Chapter 4 appears the day GAO posts it. Every row
names its edition; the 2004 annual update is returned separately under
`superseded` with the reason it is not the answer.

**Freshness.** `source_last_modified` is the `Last-Modified` of the chapter PDF
itself. The TOC page's `Last-Modified` is a Drupal render timestamp that reads as
*today* on every call — using it would tell a caller a 2019 chapter was revised
this morning.

**How matching works, and what it is worth.** Chapter titles come off GAO's live
page and are authoritative. On top of them sits `RED_BOOK_TOPIC_ALIASES` in
`src/index.ts` — **a list maintained in this pack, not something GAO publishes**, which is why every matched
row carries `match_basis` saying whether it matched `title:`, `alias:` or
`gao_scope:`. The chapters are PDFs and GovInfo does not index them, so an alias
cannot be verified against the text; entries are therefore restricted to terms
that are the standard NAME of the rule the chapter's own title states (*bona
fide needs rule* → *Availability of Appropriations: Time*), the US Code section
that rule lives at, or a plain-English framing of the question the chapter's
title asks. When nothing clears the score floor the tool returns
`match_confidence: "none"` **and the complete table of contents** rather than a
plausible wrong chapter.

### `gao_comptroller_decisions(query, date_from?, date_to?, include_reports?, page_size?)`

GovInfo files GAO audit reports and Comptroller General **decisions** under one
collection code — its own name says so, *"Government Accountability Office
Reports and Comptroller General Decisions"* — so a relevance search interleaves
them. Measured on `"augmentation of appropriations"`: 100 hits examined, **15 of
the top 25 were decisions**; this tool returns the **26 decisions and drops the
74 reports**, reporting both counts. The split is the package id (`GAOREPORTS-B-…`).

Coverage stops at 2009 — GAOREPORTS carries nothing newer. For recent bid
protests use `gao_protests_search`; for the current rule use `gao_red_book`.

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

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/govinfo/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/govinfo_list_collections \
  -H 'Content-Type: application/json' \
  -d '{}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/govinfo_list_collections`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "govinfo": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-govinfo"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-govinfo
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Govinfo data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
