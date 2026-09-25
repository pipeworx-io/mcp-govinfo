interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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
 * - gao_red_book:        topic -> the CURRENT chapter of GAO's appropriations-law treatise
 * - gao_comptroller_decisions: topic -> Comptroller General decisions (B-numbers)
 *
 * TWO HOSTS, ON PURPOSE (fleet #1972). Everything above talks to
 * api.govinfo.gov; `gao_red_book` talks to www.gao.gov, keylessly, because
 * GovInfo does not carry the current Red Book. MEASURED 2026-09-14:
 * `collection:(GAOREPORTS)` holds 16,569 packages but ZERO issued after
 * 2010-01-01, and a full-text search for "Principles of Federal Appropriations
 * Law" returns exactly ONE relevant package in its top 100 of 1,565 hits —
 * GAOREPORTS-GAO-05-354SP, the *2004 Update of the Third Edition*. Serving that
 * as current appropriations law is worse than serving nothing: GAO discontinued
 * the Annual Update entirely and the live table of contents says the current
 * Red Book is Chapters 1-3 of the FOURTH edition plus Chapters 5-15 of the
 * third. So the edition composition is read from GAO's own page on every call
 * rather than hardcoded here, and Chapter 4 will appear the day GAO posts it.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'GovInfo.gov');
}

const BASE_URL = 'https://api.govinfo.gov';
const GAO_BASE = 'https://www.gao.gov';
const RED_BOOK_TOC_URL = `${GAO_BASE}/legal/appropriations-law/red-book`;
// The Workers runtime sends no User-Agent by default and gao.gov's bot filter
// answers 403 to an unidentified client, which reads as "GAO closed its site"
// rather than as a missing header (fleet #579).
const GAO_UA = 'pipeworx-mcp-govinfo/1.0 (+https://pipeworx.io)';

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
      'Full-text + faceted search across GovInfo. Filter by one or more collection codes (BILLS, FR, CFR, USCODE, CHRG, CRPT, CREC, PLAW, USCOURTS...), date range, congress, and free-text query. Several codes search the union of those collections. Returns package IDs, titles, collection and issue dates.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search' },
        collections: {
          type: 'string',
          description:
            'Collection codes, comma- or space-separated (e.g. "CHRG" or "CHRG,CRPT"). Several codes return the union of those collections — "CHRG,CRPT" gives every package in either. Codes come from list_collections.',
        },
        congress: { type: 'number', description: 'Congress number (e.g., 118) — for BILLS/CHRG/CRPT' },
        date_from: { type: 'string', description: 'YYYY-MM-DD' },
        date_to: { type: 'string', description: 'YYYY-MM-DD' },
        page_size: { type: 'number', description: 'Results per page, 1-100 (default 25). `limit` works as an alias.' },
        limit: { type: 'number', description: 'Alias for page_size, 1-100.' },
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
        page_size: { type: 'number', description: 'Granules per page, 1-100 (default 100). `limit` works as an alias.' },
        limit: { type: 'number', description: 'Alias for page_size, 1-100.' },
        offset_mark: { type: 'string', description: 'Pagination cursor' },
      },
      required: ['package_id'],
    },
  },
  {
    name: 'get_granule',
    description: 'Fetch summary metadata for a single granule (sub-unit) within a GovInfo package, given package_id and granule_id (both from list_granules). Returns title, class, and provenance fields from the GovInfo summary endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        package_id: { type: 'string', description: 'GovInfo packageId' },
        granule_id: { type: 'string', description: 'Granule ID' },
      },
      required: ['package_id', 'granule_id'],
    },
  },
  {
    name: 'gao_red_book',
    description:
      'Find the chapter of GAO\'s Principles of Federal Appropriations Law — the Red Book — that governs a federal appropriations, fiscal-law or government-funding question, described in plain words. Answers questions about what an appropriation may lawfully be spent on (the purpose statute and the necessary expense rule), how long it stays available (the bona fide needs rule, expired and cancelled accounts, no-year and multi-year money), how much may be obligated (the Antideficiency Act, augmentation, miscellaneous receipts, apportionment), recording valid obligations, continuing resolutions and funding lapses, accountable-officer liability and relief, grants and cooperative agreements, guaranteed and insured loans, acquisition, real property, and claims for and against the government. Returns the ranked chapters together with the full table of contents, each row naming which EDITION it comes from: GAO publishes the Red Book chapter by chapter, so the current treatise is a mix of Fourth and Third Edition chapters and this reads that composition live from GAO on every call. Every row carries the chapter PDF, its source_last_modified and age_days. This is official interpretation by the agency that decides federal appropriations law, not statute — pair it with uscode or cfr text for the underlying provision.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description:
            'The fiscal-law topic or question in plain words, e.g. "can we pay for food at a conference", "bona fide needs rule", "Antideficiency Act violation", "obligating funds under a continuing resolution".',
        },
        chapter: { type: 'number', description: 'Return one specific Red Book chapter number (1-15) instead of ranking by topic.' },
        include_scope_text: {
          type: 'boolean',
          description:
            'Fetch GAO\'s own scope summary for the Fourth Edition chapters from their product pages (3 extra parallel requests). Default true.',
        },
      },
      required: [],
    },
  },
  {
    name: 'gao_comptroller_decisions',
    description:
      'Search Comptroller General decisions and opinions — the B-numbered rulings in which GAO decides federal appropriations and fiscal-law disputes, the precedent the Red Book itself cites. Give a topic in plain words (purpose statute violation, augmentation of appropriations, gift acceptance authority, improper payment, interagency agreement) and get the decisions, each with its B-number, decision date and GovInfo package. Filters out GAO audit and performance reports so the result set is decisions only, and reports how many of the underlying hits were decisions. Complements gao_red_book (the treatise) and gao_protests_search (bid-protest decisions, a different GAO docket).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text topic, e.g. "augmentation of appropriations" or "necessary expense".' },
        date_from: { type: 'string', description: 'YYYY-MM-DD' },
        date_to: { type: 'string', description: 'YYYY-MM-DD' },
        include_reports: {
          type: 'boolean',
          description: 'Also return GAO audit/performance reports from the same search, flagged as reports. Default false.',
        },
        page_size: { type: 'number', description: 'Decisions to return, 1-100 (default 25).' },
        limit: { type: 'number', description: 'Alias for page_size.' },
        offset_mark: { type: 'string', description: 'Pagination cursor from a previous response.' },
      },
      required: ['query'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  // gao_red_book reads www.gao.gov, which is keyless. Demanding a data.gov key
  // for it would refuse a call that works.
  if (name === 'gao_red_book') return gaoRedBook(args);

  const apiKey = (args._apiKey as string | undefined)?.trim();
  if (!apiKey) {
    throw new Error(
      'GovInfo requires a data.gov API key: pass your key as the _apiKey argument (free at https://api.data.gov/signup).',
    );
  }
  switch (name) {
    case 'gao_comptroller_decisions':
      return gaoComptrollerDecisions(apiKey, args);
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

// Callers reach for `limit` — it is the near-universal name for this, and the
// repro that opened fleet #555 used it. An undeclared argument is dropped in
// silence, so `limit: 1` came back with 25 rows and a 200. Accept both.
function pageSize(args: Record<string, unknown>, fallback: number): number {
  const raw = args.page_size ?? args.limit;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, Math.floor(n)));
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
  const res = await pwFetch(url, { headers: { Accept: 'application/json' } });
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
  const res = await pwFetch(url, {
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
  //
  // The free text goes in BARE. There is no `query:` field in GovInfo's query
  // language, so wrapping it as `query:"Epstein"` made the API 500 — on every
  // single call, for the life of this tool. Verified 2026-07-29:
  //   query:"Epstein"            -> 500 "Oops, Something went wrong"
  //   Epstein                    -> 200, 19,910 results
  //   Epstein collection:(CHRG)  -> 200, 510 results
  // Field filters (collection:, congress:, publishdate:) ARE real and compose
  // with the bare text via AND.
  const filters: string[] = [];
  const q = typeof args.query === 'string' ? args.query.trim() : '';
  if (q) filters.push(q);
  // Callers naturally write "CHRG,CRPT" (the arg is even plural), but a comma
  // is not a separator in GovInfo's query grammar and the whole request 500s.
  // Normalize any comma/whitespace-separated list to the OR form it wants.
  if (args.collections) {
    const codes = String(args.collections).split(/[,\s]+/).map((c) => c.trim()).filter(Boolean);
    if (codes.length) filters.push(`collection:(${codes.join(' OR ')})`);
  }
  if (args.congress) filters.push(`congress:${args.congress}`);
  if (args.date_from && args.date_to) {
    filters.push(`publishdate:range(${args.date_from},${args.date_to})`);
  } else if (args.date_from) {
    filters.push(`publishdate:range(${args.date_from},)`);
  } else if (args.date_to) {
    filters.push(`publishdate:range(,${args.date_to})`);
  }

  if (!filters.length) {
    throw new Error(
      'Provide either a free-text query or at least one filter (collections, congress, date_from/date_to). ' +
      'An empty search would ask GovInfo for every package it has.',
    );
  }

  const body = {
    query: filters.join(' AND '),
    pageSize: pageSize(args, 25),
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
    pageSize: String(pageSize(args, 100)),
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

// ─────────────────────────────────────────────────────────────────────────────
// GAO Red Book — topic-level discovery over GAO's appropriations-law treatise
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A hand-maintained topic-to-chapter alias list for the Red Book.
 *
 * Read this as what it is: a hand-written alias list, NOT something derived from
 * the text. Chapter TITLES come off GAO's live page on every call and are
 * authoritative; these aliases are ours, so every matched row says which of the
 * two it matched on (`match_basis`) and a caller can discount accordingly. The
 * entries are deliberately restricted to terms that are the standard NAME of
 * the rule the chapter's own title states — "bona fide needs rule" for
 * *Availability of Appropriations: Time*, "Antideficiency Act" for *Amount* —
 * plus the US Code sections those rules live at. Nothing here is a guess at
 * what a chapter covers beyond its title, because a plausible wrong chapter is
 * a confident wrong answer and this tool cannot verify one: the chapters are
 * PDFs and GovInfo does not index them.
 *
 * Extending it: add a term only if you can point at the chapter title or the
 * statute it names. If a topic genuinely has no home here, leaving it out is
 * correct — the tool returns the whole table of contents with
 * match_confidence:"none" and lets the caller choose.
 */
const RED_BOOK_TOPIC_ALIASES: Record<number, string[]> = {
  1: ['power of the purse', 'constitutional', 'separation of powers', 'gao role', 'comptroller general authority', 'introduction'],
  2: ['terminology', 'definitions', 'budget process', 'appropriations process', 'budget authority', 'types of appropriations', 'legal framework', 'authorization versus appropriation'],
  3: ['purpose statute', 'necessary expense', 'necessary expense rule', '31 u.s.c. 1301', '1301(a)', 'available for its objects', 'permissible use of funds', 'what can appropriated funds be spent on',
      // The purpose chapter answers "may this appropriation be spent on X",
      // so the plain-English framings of that question route here. Kept to
      // verbs of spending, not to any particular X — we do not claim to know
      // which items the chapter discusses.
      'pay for', 'spend', 'spent', 'spending', 'buy', 'purchase', 'permissible', 'allowable', 'improper purpose', 'use appropriated funds'],
  4: [],
  5: ['bona fide needs', 'bona fide needs rule', '31 u.s.c. 1502', '1502(a)', 'period of availability', 'fiscal year availability', 'expired appropriation', 'cancelled appropriation', 'no-year funds', 'multiple year funds', 'advance payment', 'severable services',
      // Plain-English framings of "for how long is this money available".
      'expire', 'expired', 'expires', 'carry over', 'carryover', 'year end', 'end of the fiscal year', 'how long'],
  6: ['antideficiency act', '31 u.s.c. 1341', '31 u.s.c. 1517', 'augmentation', 'augmentation of appropriations', 'miscellaneous receipts', '31 u.s.c. 3302', 'apportionment', 'over-obligation', 'deficiency', 'voluntary services', 'gift acceptance',
      // Plain-English framings of "how much may be obligated".
      'exceed', 'overspend', 'more than appropriated', 'ran out of money', 'without an appropriation'],
  7: ['recording statute', '31 u.s.c. 1501', 'valid obligation', 'recording obligations', 'deobligation', 'when is an obligation incurred'],
  8: ['continuing resolution', 'cr', 'government shutdown', 'lapse in appropriations', 'stopgap funding', 'funding gap'],
  9: ['accountable officer', 'certifying officer', 'disbursing officer', 'physical loss of funds', 'relief of liability', 'improper payment'],
  10: ['grant', 'grants', 'cooperative agreement', 'federal assistance', 'subgrant', 'uniform guidance', '2 c.f.r. 200'],
  11: ['loan guarantee', 'guaranteed loan', 'insured loan', 'credit reform', 'federal credit reform act'],
  12: ['procurement', 'acquisition', 'government contract', 'far', 'competition', 'contract funding'],
  13: ['real property', 'lease', 'leasing', 'land acquisition', 'building', 'construction'],
  14: ['claim against the government', 'claims', 'setoff', 'debt collection', 'erroneous payment', 'waiver of indebtedness', 'tucker act'],
  15: ['miscellaneous'],
};

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'is', 'are', 'can', 'we', 'i', 'it', 'be', 'does',
  'do', 'what', 'when', 'how', 'why', 'which', 'with', 'from', 'that', 'this', 'may', 'must', 'should', 'law',
  'legal', 'rule', 'rules', 'federal', 'government', 'appropriation', 'appropriations', 'funds', 'fund', 'money',
  // Function words long enough to clear the length floor. Without these, the
  // single token "under" in "obligating funds under a continuing resolution"
  // matched a chapter's scope text and put the wrong chapter in the answer.
  'under', 'over', 'into', 'their', 'there', 'them', 'they', 'its', 'our', 'will', 'would', 'could', 'any', 'all',
  'not', 'was', 'were', 'has', 'have', 'had', 'been', 'but', 'than', 'then', 'also', 'such', 'about', 'after',
  'before', 'during', 'within', 'between', 'each', 'other', 'some', 'one', 'two', 'agency', 'agencies',
]);

type RedBookChapter = {
  chapter: number;
  edition: string | null;
  edition_label: string | null;
  title: string | null;
  status: string;
  pdf_urls: string[];
  pdf_labels: string[];
  scope: string | null;
  source_last_modified: string | null;
  age_days: number | null;
  score: number;
  match_basis: string[];
};

// GAO's product pages for the Fourth Edition chapters, which carry GAO's own
// one-sentence scope summary. Verified live 2026-09-14 — each page's
// <meta name="description"> opens "Chapter N of Principles of Federal
// Appropriations Law…". Not load-bearing: an unknown or moved id just means the
// chapter comes back with scope:null, never a wrong scope.
const RED_BOOK_PRODUCT_PAGES: Record<number, string> = {
  1: 'gao-16-463sp',
  2: 'gao-16-464sp',
  3: 'gao-17-797sp',
};

type TocCache = { at: number; toc: RedBookChapter[]; composition: string | null; scope: Record<number, string> };
let tocCache: TocCache | null = null;
const TOC_TTL_MS = 6 * 60 * 60 * 1000; // GAO ships a chapter every year or two.

async function gaoFetchText(url: string): Promise<string> {
  const res = await pwFetch(url, {
    headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': GAO_UA },
  });
  if (!res.ok) throw new Error(`GAO.gov: HTTP ${res.status} for ${url}`);
  return res.text();
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&#8217;/g, "'")
    .replace(/&ldquo;|&rdquo;|&#8220;|&#8221;/g, '"')
    .replace(/&ndash;|&#8211;/g, '-')
    .replace(/&mdash;|&#8212;/g, '—')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)));
}

function stripTags(html: string): string {
  return unescapeHtml(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

const ORDINALS: Record<string, string> = { '1': '1st', '2': '2nd', '3': '3rd', '4': '4th' };

/**
 * Parse GAO's Red Book table of contents.
 *
 * The links column is ROWSPANNED — one 3rd-edition volume PDF covers a run of
 * chapters, so chapters 7-11 arrive as two-cell rows and inherit the volume
 * cell opened at chapter 6. Carrying the last links cell forward is what makes
 * those chapters resolvable at all. The carry is reset by any 3-cell row,
 * including the empty one GAO uses for the not-yet-published chapter — without
 * that reset, Chapter 4 would inherit Chapter 3's PDF and we would hand a
 * caller the wrong chapter with a clean 200.
 */
function parseRedBookToc(html: string): { toc: RedBookChapter[]; composition: string | null } {
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  const toc: RedBookChapter[] = [];
  let carriedUrls: string[] = [];
  let carriedLabels: string[] = [];

  if (tableMatch) {
    const rows = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    for (const row of rows) {
      const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1]);
      if (cells.length < 2) continue;
      const chapMatch = stripTags(cells[0]).match(/(\d)(?:st|nd|rd|th)\s+Edition,?\s+Chapter\s+(\d+)/i);
      if (!chapMatch) continue;
      const editionDigit = chapMatch[1];
      const chapter = Number(chapMatch[2]);
      const title = stripTags(cells[1]);

      if (cells.length >= 3) {
        const linkCell = cells[cells.length - 1];
        carriedUrls = [...linkCell.matchAll(/href="([^"]+)"/gi)].map((m) =>
          m[1].startsWith('http') ? m[1] : `${GAO_BASE}${m[1]}`,
        );
        carriedLabels = [...linkCell.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => stripTags(m[1]));
      }

      // GAO writes "Coming soon!" in the title column for an announced chapter
      // that has no PDF yet. Reporting it as published-with-no-link would read
      // as a broken row; reporting it as absent hides that GAO has said it is
      // coming. It is neither, so it gets its own status.
      const announced = /coming soon/i.test(title);
      toc.push({
        chapter,
        edition: ORDINALS[editionDigit] ?? editionDigit,
        edition_label: `${ORDINALS[editionDigit] ?? editionDigit} Edition, Chapter ${chapter}`,
        title: announced ? null : title,
        status: announced ? 'announced_not_yet_published' : 'published',
        pdf_urls: announced ? [] : carriedUrls,
        pdf_labels: announced ? [] : carriedLabels,
        scope: null,
        source_last_modified: null,
        age_days: null,
        score: 0,
        match_basis: [],
      });
    }
  }

  const text = stripTags(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ''));
  const comp = text.match(/Our current Red Book consists of[^.]*\./i);
  return { toc, composition: comp ? comp[0] : null };
}

async function fetchChapterScopes(): Promise<Record<number, string>> {
  const entries = await Promise.all(
    Object.entries(RED_BOOK_PRODUCT_PAGES).map(async ([chap, productId]) => {
      try {
        const html = await gaoFetchText(`${GAO_BASE}/products/${productId}`);
        const m = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
        return [Number(chap), m ? unescapeHtml(m[1]) : ''] as const;
      } catch {
        return [Number(chap), ''] as const;
      }
    }),
  );
  const out: Record<number, string> = {};
  for (const [chap, scope] of entries) if (scope) out[chap] = scope;
  return out;
}

async function loadRedBook(includeScope: boolean): Promise<TocCache> {
  if (tocCache && Date.now() - tocCache.at < TOC_TTL_MS && (!includeScope || Object.keys(tocCache.scope).length)) {
    return tocCache;
  }
  // Parallel, not sequential: Promise.all costs max() of the two legs, not the
  // sum, and the answer budget is shared with whatever the caller asked next.
  const [html, scope] = await Promise.all([
    gaoFetchText(RED_BOOK_TOC_URL),
    includeScope ? fetchChapterScopes() : Promise.resolve({} as Record<number, string>),
  ]);
  const { toc, composition } = parseRedBookToc(html);
  if (!toc.length) {
    throw new Error(
      'GAO.gov returned the Red Book page but no chapter table could be read from it — the page layout has changed and gao_red_book needs its parser updated.',
    );
  }
  tocCache = { at: Date.now(), toc, composition, scope };
  return tocCache;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9.()§ -]/g, ' ')
    .split(/[\s-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function scoreChapter(chap: RedBookChapter, topic: string): { score: number; basis: string[] } {
  const low = topic.toLowerCase();
  const tokens = tokenize(topic);
  const basis: string[] = [];
  let score = 0;

  // A chapter title is GAO's own text, fetched this call — the strongest signal
  // available and the only one that cannot be stale.
  const titleTokens = new Set(tokenize(chap.title ?? ''));
  const titleHits = [...new Set(tokens)].filter((t) => titleTokens.has(t));
  if (titleHits.length) {
    score += 5 * titleHits.length;
    basis.push(`title:${titleHits.join(',')}`);
  }

  // The alias list below, maintained in this pack. A whole-phrase alias
  // inside the question is a strong,
  // low-ambiguity signal ("bona fide needs"); a single alias token is weak.
  for (const alias of RED_BOOK_TOPIC_ALIASES[chap.chapter] ?? []) {
    if (alias.includes(' ') || alias.includes('.')) {
      if (low.includes(alias)) {
        score += 6;
        basis.push(`alias:"${alias}"`);
      }
    } else if (tokens.includes(alias)) {
      score += 2;
      basis.push(`alias:${alias}`);
    }
  }

  if (chap.scope) {
    const scopeTokens = new Set(tokenize(chap.scope));
    const scopeHits = [...new Set(tokens)].filter((t) => scopeTokens.has(t) && !titleTokens.has(t));
    if (scopeHits.length) {
      score += scopeHits.length;
      basis.push(`gao_scope:${scopeHits.join(',')}`);
    }
  }

  return { score, basis };
}

function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

/**
 * The PDF's own Last-Modified is the only real content-freshness signal on
 * gao.gov. The TOC page's Last-Modified is a Drupal render timestamp — it reads
 * as "today" on every call (measured), so a caller shown that would conclude
 * a 2019 chapter was revised this morning.
 */
async function pdfLastModified(url: string): Promise<string | null> {
  try {
    const res = await pwFetch(url, { method: 'HEAD', headers: { 'User-Agent': GAO_UA } });
    const lm = res.headers.get('last-modified');
    return lm ? new Date(lm).toISOString() : null;
  } catch {
    return null;
  }
}

async function gaoRedBook(args: Record<string, unknown>) {
  const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
  const wantChapter = typeof args.chapter === 'number' ? args.chapter : undefined;
  const includeScope = args.include_scope_text !== false;

  const { toc, composition, scope } = await loadRedBook(includeScope);
  const retrievedAt = new Date().toISOString();
  for (const c of toc) c.scope = scope[c.chapter] ?? null;

  let matched: RedBookChapter[];
  let confidence: string;

  if (wantChapter !== undefined) {
    matched = toc.filter((c) => c.chapter === wantChapter);
    confidence = matched.length ? 'exact_chapter' : 'none';
  } else if (topic) {
    for (const c of toc) {
      const { score, basis } = scoreChapter(c, topic);
      c.score = score;
      c.match_basis = basis;
    }
    // Floor of 2: a single weak signal (one shared scope word, one bare alias
    // token) is noise, and a noisy row in `matched_chapters` reads as a
    // recommendation. Below the floor the caller gets the table of contents and
    // match_confidence:"none", which is the honest answer.
    const scored = toc.filter((c) => c.score >= 2).sort((a, b) => b.score - a.score);
    matched = scored.slice(0, 3);
    confidence = matched.length === 0 ? 'none' : matched[0].score >= 5 ? 'high' : 'low';
  } else {
    matched = [];
    confidence = 'no_topic_given';
  }

  // Bounded: HEAD only the chapters we are actually recommending. Doing all 15
  // would be 15 requests to answer one question.
  await Promise.all(
    matched.map(async (c) => {
      if (!c.pdf_urls.length) return;
      c.source_last_modified = await pdfLastModified(c.pdf_urls[0]);
      c.age_days = ageDays(c.source_last_modified);
    }),
  );

  const currentEditions = [...new Set(toc.filter((c) => c.status === 'published').map((c) => c.edition))];

  return {
    found: matched.length > 0 || confidence === 'no_topic_given',
    source: 'GAO, Principles of Federal Appropriations Law (the "Red Book")',
    publisher: 'U.S. Government Accountability Office',
    // The Red Book is GAO's systematic treatise on appropriations law, so it is
    // `legal_treatise` (tier 3, practitioner_guidance) — NOT the same type as the
    // Comptroller General decisions it cites, which gao_comptroller_decisions
    // labels `agency_guidance` (tier 2). Same publisher, different instruments: a
    // single uniform authority_type for the GAO corpus is wrong whichever one you
    // pick. `official_interpretation` shipped here in #1972 and was wrong twice
    // over — it is a TIER, not a type, and it is not this document's tier anyway.
    authority_type: 'legal_treatise',
    authority_tier: 'practitioner_guidance',
    jurisdiction: 'us-federal',
    // Coded value ranks and filters; the sentence explains. Nothing ever parses
    // one into the other — see BINDING_STATUS_IS_CODED_PLUS_PROSE in
    // shared/src/authority.ts.
    binding_status: 'persuasive',
    binding_note:
      'GAO\'s own view of federal appropriations law. Persuasive and followed in practice by agency counsel; not binding on courts.',
    table_of_contents_url: RED_BOOK_TOC_URL,
    // Straight from GAO's page, not from us: "Our current Red Book consists of
    // Chapters 1-3 (of the 4th Edition) and Chapters 5-15 (of the 3rd Edition)."
    current_edition_note: composition,
    editions_in_force: currentEditions,
    retrieved_at: retrievedAt,
    match_confidence: confidence,
    match_basis_legend:
      'title = matched GAO\'s own chapter title, read live this call. alias = matched Pipeworx\'s topic index (see the pack README). gao_scope = matched GAO\'s product-page scope summary.',
    matched_chapters: matched.map(redBookRow),
    table_of_contents: toc.map(redBookRow),
    superseded: [
      {
        package_id: 'GAOREPORTS-GAO-05-354SP',
        title: 'Principles of Federal Appropriations Law: 2004 Update of the Third Edition',
        date_issued: '2005-03-01',
        why_not_current:
          'The only Red Book package GovInfo carries, and it is a 2004 annual update to the Third Edition. GAO has discontinued the Annual Update entirely and does not list it in the current table of contents. It is legal history, not current appropriations law — a full-text GovInfo search returns it as the single relevant hit and it is the wrong answer.',
      },
    ],
    note:
      matched.length === 0 && topic
        ? 'No chapter matched that topic. The complete table of contents is returned above so you can pick one — every row is part of the current Red Book, with its edition named.'
        : null,
  };
}

function redBookRow(c: RedBookChapter) {
  return {
    chapter: c.chapter,
    edition: c.edition,
    citation_label: c.edition_label,
    title: c.title,
    status: c.status,
    is_current: c.status === 'published',
    scope: c.scope,
    pdf_urls: c.pdf_urls,
    pdf_labels: c.pdf_labels,
    source_last_modified: c.source_last_modified,
    age_days: c.age_days,
    relevance_score: c.score,
    match_basis: c.match_basis,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Comptroller General decisions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GovInfo's GAOREPORTS collection mixes two very different things under one
 * code: GAO audit/performance reports and Comptroller General DECISIONS. Its
 * own name says so — "Government Accountability Office Reports and Comptroller
 * General Decisions" — and a relevance search over 16,569 packages interleaves
 * them, which is why a fiscal-law question comes back looking like noise. The
 * split is in the package id: a decision is GAOREPORTS-B-<number>.
 */
function isDecision(packageId: string | null): boolean {
  return !!packageId && /^GAOREPORTS-B-/i.test(packageId);
}

async function gaoComptrollerDecisions(apiKey: string, args: Record<string, unknown>) {
  const want = pageSize(args, 25);
  const includeReports = args.include_reports === true;
  // Over-fetch, because filtering happens here: asking for exactly `want` rows
  // upstream and then dropping the reports would return fewer decisions than
  // asked for and look like the collection was thin.
  const upstream = await searchPackages(apiKey, {
    query: reqStr(args, 'query', '"augmentation of appropriations"'),
    collections: 'GAOREPORTS',
    date_from: args.date_from,
    date_to: args.date_to,
    page_size: 100,
    offset_mark: args.offset_mark,
  });

  const decisions = upstream.results.filter((r) => isDecision(r.package_id));
  const reports = upstream.results.filter((r) => !isDecision(r.package_id));

  return {
    total_collection_hits: upstream.total,
    upstream_examined: upstream.returned,
    decisions_found: decisions.length,
    reports_filtered_out: includeReports ? 0 : reports.length,
    next_offset_mark: upstream.next_offset_mark,
    // A Comptroller General decision is the issuing body's own reading of the
    // appropriations statutes it administers — `agency_guidance`, tier 2
    // (official_interpretation). Contrast gao_red_book, which is the treatise
    // built ON these decisions and is therefore tier 3.
    authority_type: 'agency_guidance',
    authority_tier: 'official_interpretation',
    jurisdiction: 'us-federal',
    issuer: 'Comptroller General of the United States',
    // 'persuasive' rather than 'binding_on_issuer': these decisions direct
    // agencies that are not their issuer (GAO decides, the agency complies), so
    // the enum value reserved for an agency's own internal manual would be wrong.
    // The force they actually carry over those agencies is what binding_note is
    // for — the sentence is not a status and is never parsed into one.
    binding_status: 'persuasive',
    binding_note:
      'A Comptroller General decision binds the agencies that must account to GAO and is the precedent the Red Book cites; it does not bind courts.',
    retrieved_at: new Date().toISOString(),
    decisions: decisions.map((r) => ({
      ...r,
      document_type: 'comptroller_general_decision',
      source_last_modified: r.last_modified,
      age_days: ageDays(r.last_modified),
    })),
    reports: includeReports
      ? reports.map((r) => ({
          ...r,
          document_type: 'gao_report',
          source_last_modified: r.last_modified,
          age_days: ageDays(r.last_modified),
        }))
      : undefined,
    note: decisions.length
      ? 'GovInfo carries Comptroller General decisions through the 2000s only — GAOREPORTS holds nothing issued after 2009 (measured). For the current appropriations-law treatise use gao_red_book; for recent bid protests use gao_protests_search.'
      : 'No Comptroller General decision in this collection matched. GAOREPORTS holds nothing issued after 2009 (measured), so a recent matter will not be here — try gao_red_book for the governing rule or gao_protests_search for bid protests.',
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
