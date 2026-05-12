interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * GovInfo.gov MCP — full text of US government publications
 *
 * GovInfo carries the authoritative full text of US laws, regulations, and
 * congressional materials: BILLS, USCODE, CFR, eCFR, Federal Register,
 * Congressional Record, hearings, House/Senate documents, public laws,
 * Statutes at Large, US Reports, Code of Federal Regulations.
 *
 * Complement to `federal-register` (FR metadata only) and `congress`.
 *
 * API: https://api.govinfo.gov/docs
 * Auth: `?api_key=` query (reuses data.gov key).
 *
 * Tools:
 * - list_collections:    available collections (BILLS, CFR, etc.)
 * - search_packages:     search across or within a collection
 * - get_package:         metadata for a package (e.g., one issue, one bill)
 * - list_granules:       sub-units inside a package (sections of a CFR title)
 * - get_granule:         single granule metadata
 */


const BASE_URL = 'https://api.govinfo.gov';

const tools: McpToolExport['tools'] = [
  {
    name: 'list_collections',
    description:
      'List GovInfo collections (BILLS, CFR, USCODE, FR, CHRG, CRPT, HMAN, PLAW, SERIALSET, USCOURTS, etc.) with package counts. Use the collection code with search_packages to filter.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_packages',
    description:
      'Full-text + faceted search across GovInfo. Filter by collection codes (comma-separated), date range, congress, court (for USCOURTS), and free-text query. Returns package IDs and titles.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search' },
        collections: {
          type: 'string',
          description: 'Comma-separated collection codes (e.g., "BILLS,FR")',
        },
        congress: { type: 'number', description: 'Congress number (e.g., 118) — for BILLS/CHRG/CRPT' },
        date_from: { type: 'string', description: 'YYYY-MM-DD' },
        date_to: { type: 'string', description: 'YYYY-MM-DD' },
        page_size: { type: 'number', description: '1-100 (default 25)' },
        offset_mark: { type: 'string', description: 'Pagination cursor from previous response' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_package',
    description:
      'Metadata for a single package by packageId (e.g., "BILLS-118hr1234ih", "FR-2024-05-12"). Returns title, dates, citations, granule count, download links (PDF/XML/MODS).',
    inputSchema: {
      type: 'object',
      properties: {
        package_id: { type: 'string', description: 'GovInfo packageId' },
      },
      required: ['package_id'],
    },
  },
  {
    name: 'list_granules',
    description:
      'List granules within a package — e.g., sections of a CFR title, individual entries in a Federal Register issue. Returns granule IDs + titles.',
    inputSchema: {
      type: 'object',
      properties: {
        package_id: { type: 'string', description: 'GovInfo packageId' },
        page_size: { type: 'number', description: '1-100 (default 100)' },
        offset_mark: { type: 'string', description: 'Pagination cursor' },
      },
      required: ['package_id'],
    },
  },
  {
    name: 'get_granule',
    description: 'Granule metadata for a sub-unit within a package.',
    inputSchema: {
      type: 'object',
      properties: {
        package_id: { type: 'string', description: 'GovInfo packageId' },
        granule_id: { type: 'string', description: 'Granule ID' },
      },
      required: ['package_id', 'granule_id'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const apiKey = (args._apiKey as string | undefined)?.trim();
  if (!apiKey) {
    throw new Error(
      'GovInfo requires a data.gov API key. Contact the operator about platform credentials (PLATFORM_DATAGOV_KEY), or BYO via ?_apiKey=<key> after registering at https://api.data.gov/signup.',
    );
  }
  switch (name) {
    case 'list_collections':
      return listCollections(apiKey);
    case 'search_packages':
      return searchPackages(apiKey, args);
    case 'get_package':
      return getPackage(apiKey, reqStr(args, 'package_id', '"BILLS-118hr1234ih"'));
    case 'list_granules':
      return listGranules(apiKey, args);
    case 'get_granule':
      return getGranule(
        apiKey,
        reqStr(args, 'package_id', '"PLAW-117publ328"'),
        reqStr(args, 'granule_id', '"<granule_id>"'),
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing or empty. Pass a string like ${example}.`);
  }
  return v;
}

async function giFetch<T>(apiKey: string, path: string, params: URLSearchParams): Promise<T> {
  params.set('api_key', apiKey);
  const url = `${BASE_URL}${path}?${params}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) throw new Error('GovInfo: unauthorized — check the data.gov key');
  if (res.status === 404) throw new Error('GovInfo: not found (HTTP 404)');
  if (res.status === 429) throw new Error('GovInfo: rate-limit (HTTP 429)');
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GovInfo error: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function giPost<T>(apiKey: string, path: string, body: unknown): Promise<T> {
  const url = `${BASE_URL}${path}?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) throw new Error('GovInfo: unauthorized — check the data.gov key');
  if (res.status === 429) throw new Error('GovInfo: rate-limit (HTTP 429)');
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GovInfo error: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

async function listCollections(apiKey: string) {
  const data = await giFetch<{
    collections?: { collectionCode?: string; collectionName?: string; packageCount?: number; granuleCount?: number }[];
  }>(apiKey, '/collections', new URLSearchParams());
  return {
    count: data.collections?.length ?? 0,
    collections: (data.collections ?? []).map((c) => ({
      code: c.collectionCode ?? null,
      name: c.collectionName ?? null,
      package_count: c.packageCount ?? null,
      granule_count: c.granuleCount ?? null,
    })),
  };
}

async function searchPackages(apiKey: string, args: Record<string, unknown>) {
  // GovInfo search uses POST /search with a JSON body.
  const filters: string[] = [`query:"${String(args.query).replace(/"/g, '\\"')}"`];
  if (args.collections) filters.push(`collection:(${String(args.collections)})`);
  if (args.congress) filters.push(`congress:${args.congress}`);
  if (args.date_from && args.date_to) {
    filters.push(`publishdate:range(${args.date_from},${args.date_to})`);
  } else if (args.date_from) {
    filters.push(`publishdate:range(${args.date_from},)`);
  } else if (args.date_to) {
    filters.push(`publishdate:range(,${args.date_to})`);
  }

  const body = {
    query: filters.join(' AND '),
    pageSize: Math.min(100, Math.max(1, (args.page_size as number) ?? 25)),
    offsetMark: (args.offset_mark as string) ?? '*',
    sorts: [{ field: 'relevancy', sortOrder: 'DESC' }],
  };

  const data = await giPost<{
    count?: number;
    offsetMark?: string;
    results?: {
      packageId?: string;
      title?: string;
      collectionCode?: string;
      collectionName?: string;
      dateIssued?: string;
      lastModified?: string;
      packageLink?: string;
      detailsLink?: string;
    }[];
  }>(apiKey, '/search', body);

  return {
    total: data.count ?? 0,
    next_offset_mark: data.offsetMark ?? null,
    returned: data.results?.length ?? 0,
    results: (data.results ?? []).map((r) => ({
      package_id: r.packageId ?? null,
      title: r.title ?? null,
      collection: r.collectionCode ?? null,
      collection_name: r.collectionName ?? null,
      date_issued: r.dateIssued ?? null,
      last_modified: r.lastModified ?? null,
      package_link: r.packageLink ?? null,
      details_link: r.detailsLink ?? null,
    })),
  };
}

async function getPackage(apiKey: string, packageId: string) {
  const data = await giFetch<Record<string, unknown>>(apiKey, `/packages/${encodeURIComponent(packageId)}/summary`, new URLSearchParams());
  return data;
}

async function listGranules(apiKey: string, args: Record<string, unknown>) {
  const packageId = reqStr(args, 'package_id', '"FR-2024-05-12"');
  const params = new URLSearchParams({
    pageSize: String(Math.min(100, Math.max(1, (args.page_size as number) ?? 100))),
  });
  if (args.offset_mark) params.set('offsetMark', String(args.offset_mark));
  else params.set('offsetMark', '*');

  const data = await giFetch<{
    count?: number;
    offsetMark?: string;
    granules?: { granuleId?: string; title?: string; granuleClass?: string; granuleLink?: string }[];
  }>(apiKey, `/packages/${encodeURIComponent(packageId)}/granules`, params);

  return {
    package_id: packageId,
    total: data.count ?? 0,
    next_offset_mark: data.offsetMark ?? null,
    returned: data.granules?.length ?? 0,
    granules: (data.granules ?? []).map((g) => ({
      id: g.granuleId ?? null,
      title: g.title ?? null,
      class: g.granuleClass ?? null,
      link: g.granuleLink ?? null,
    })),
  };
}

async function getGranule(apiKey: string, packageId: string, granuleId: string) {
  const data = await giFetch<Record<string, unknown>>(
    apiKey,
    `/packages/${encodeURIComponent(packageId)}/granules/${encodeURIComponent(granuleId)}/summary`,
    new URLSearchParams(),
  );
  return data;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
