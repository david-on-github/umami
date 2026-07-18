import clickhouse from '@/lib/clickhouse';
import { HEATMAP_EVENT_TYPE, OPERATORS } from '@/lib/constants';
import { CLICKHOUSE, PRISMA, runQuery } from '@/lib/db';
import { filtersObjectToArray } from '@/lib/params';
import prisma from '@/lib/prisma';
import type { QueryFilters } from '@/lib/types';
import { getWebsite } from '@/queries/prisma';

const FUNCTION_NAME = 'getHeatmap';

const POINT_LIMIT = 5000;
const PAGE_LIMIT = 100;
const SCROLL_BUCKET_SIZE = 10;

export type HeatmapMode = 'click' | 'scroll';

export interface HeatmapParameters extends QueryFilters {
  urlPath?: string;
  urlHostname?: string;
  mode?: HeatmapMode;
}

export interface HeatmapPage {
  urlPath: string;
  hostname: string;
  count: number;
  sessions: number;
}

export interface HeatmapPoint {
  x: number;
  y: number;
  pageX: number;
  pageY: number;
  pageW: number;
  pageH: number;
  viewportW: number;
  viewportH: number;
  count: number;
}

export interface HeatmapScrollBucket {
  depth: number;
  sessions: number;
  pageW: number;
  pageH: number;
  viewportW: number;
  viewportH: number;
}

export interface HeatmapSnapshotIframe {
  kind: 'iframe';
  id: string;
  url: string;
  pageW: number;
  pageH: number;
  viewportW: number;
  viewportH: number;
}

export type HeatmapSnapshot = HeatmapSnapshotIframe;

export interface HeatmapResult {
  mode: HeatmapMode;
  pages: HeatmapPage[];
  points: HeatmapPoint[];
  snapshot: HeatmapSnapshot | null;
  scroll: {
    buckets: HeatmapScrollBucket[];
    totalSessions: number;
    pageW: number | null;
    pageH: number | null;
    viewportW: number | null;
    viewportH: number | null;
  };
}

export async function getHeatmap(
  websiteId: string,
  parameters: HeatmapParameters,
): Promise<HeatmapResult> {
  return runQuery({
    [PRISMA]: () => relationalQuery(websiteId, parameters),
    [CLICKHOUSE]: () => clickhouseQuery(websiteId, parameters),
  });
}

interface HeatmapFilterContext {
  joinQuery: string;
  filterQuery: string;
  queryParams: Record<string, any>;
}

async function relationalQuery(
  websiteId: string,
  parameters: HeatmapParameters,
): Promise<HeatmapResult> {
  const { rawQuery } = prisma;
  const { startDate, endDate, urlPath, urlHostname, mode = 'click' } = parameters;
  const eventType = mode === 'scroll' ? HEATMAP_EVENT_TYPE.scroll : HEATMAP_EVENT_TYPE.click;
  const filterContext = getRelationalHeatmapFilterContext(websiteId, parameters);
  // '' selects legacy rows recorded before src_hostname existed (stored as null).
  const urlHostnameFilter =
    urlHostname === undefined
      ? ''
      : urlHostname
        ? 'and h.src_hostname = {{urlHostname}}'
        : 'and h.src_hostname is null';
  const urlHostnameParams = urlHostname ? { urlHostname } : {};
  const pageFilter =
    mode === 'click'
      ? `
      and x is not null
      and y is not null
      and page_x is not null
      and page_y is not null
      and page_w is not null
      and page_h is not null
      and viewport_w is not null
      and viewport_h is not null
    `
      : `
      and scroll_pct is not null
      and page_w is not null
      and page_h is not null
      and viewport_w is not null
      and viewport_h is not null
    `;

  const rawPages: (Omit<HeatmapPage, 'hostname'> & { hostname: string | null })[] = await rawQuery(
    `
    select
      h.url_path as "urlPath",
      h.src_hostname as "hostname",
      count(*)::int as count,
      count(distinct h.visit_id)::int as sessions
    from heatmap_event h
    ${filterContext.joinQuery}
    where h.website_id = {{websiteId::uuid}}
      and h.event_type = {{eventType}}
      and h.created_at between {{startDate}} and {{endDate}}
      ${filterContext.filterQuery}
      ${pageFilter}
    group by h.url_path, h.src_hostname
    order by sessions desc, count desc
    limit ${PAGE_LIMIT}
    `,
    { ...filterContext.queryParams, websiteId, eventType, startDate, endDate },
    FUNCTION_NAME,
  );
  const pages: HeatmapPage[] = rawPages.map(p => ({ ...p, hostname: p.hostname ?? '' }));

  if (!urlPath) {
    return { mode, pages, points: [], snapshot: null, scroll: emptyScroll() };
  }

  if (mode === 'scroll') {
    const bucketRows: {
      depth: number | string;
      sessions: number | string;
      pageW: number | string;
      pageH: number | string;
      viewportW: number | string;
      viewportH: number | string;
    }[] = await rawQuery(
      `
      select
        (floor(max_pct / ${SCROLL_BUCKET_SIZE}) * ${SCROLL_BUCKET_SIZE})::int as depth,
        count(*)::int as sessions,
        page_w::int as "pageW",
        page_h::int as "pageH",
        viewport_w::int as "viewportW",
        viewport_h::int as "viewportH"
      from (
        select
          h.visit_id,
          max(h.scroll_pct) as max_pct,
          (mode() within group (order by h.page_w))::int as page_w,
          (mode() within group (order by h.page_h))::int as page_h,
          (mode() within group (order by h.viewport_w))::int as viewport_w,
          (mode() within group (order by h.viewport_h))::int as viewport_h
        from heatmap_event h
        ${filterContext.joinQuery}
        where h.website_id = {{websiteId::uuid}}
          and h.event_type = {{eventType}}
          and h.url_path = {{urlPath}}
          ${urlHostnameFilter}
          and h.created_at between {{startDate}} and {{endDate}}
          ${filterContext.filterQuery}
          and h.scroll_pct is not null
          and h.page_w is not null
          and h.page_h is not null
          and h.viewport_w is not null
          and h.viewport_h is not null
        group by h.visit_id
      ) per_session
      group by depth, page_w, page_h, viewport_w, viewport_h
      order by depth
      `,
      { ...filterContext.queryParams, ...urlHostnameParams, websiteId, eventType, urlPath, startDate, endDate },
      FUNCTION_NAME,
    );

    const scrollBuckets = bucketRows.map(r => ({
      depth: Number(r.depth),
      sessions: Number(r.sessions),
      pageW: Number(r.pageW),
      pageH: Number(r.pageH),
      viewportW: Number(r.viewportW),
      viewportH: Number(r.viewportH),
    }));
    const viewport = pickScrollSnapshotViewport(scrollBuckets);
    const scroll = {
      buckets: scrollBuckets,
      totalSessions: scrollBuckets.reduce((sum, bucket) => sum + bucket.sessions, 0),
      pageW: viewport?.pageW ?? null,
      pageH: viewport?.pageH ?? null,
      viewportW: viewport?.width ?? null,
      viewportH: viewport?.height ?? null,
    };
    const snapshot = await resolveHeatmapSnapshot({
      websiteId,
      urlPath,
      hostname: urlHostname || getSnapshotHostname(parameters),
      viewportW: viewport?.width ?? null,
      viewportH: viewport?.height ?? null,
      pageW: viewport?.pageW ?? null,
      pageH: viewport?.pageH ?? null,
    });

    return {
      mode,
      pages,
      points: [],
      snapshot,
      scroll,
    };
  }

  const rawPoints: HeatmapPoint[] = await rawQuery(
    `
    select
      h.x,
      h.y,
      h.page_x as "pageX",
      h.page_y as "pageY",
      h.page_w as "pageW",
      h.page_h as "pageH",
      h.viewport_w as "viewportW",
      h.viewport_h as "viewportH",
      count(*)::int as count
    from heatmap_event h
    ${filterContext.joinQuery}
    where h.website_id = {{websiteId::uuid}}
      and h.event_type = {{eventType}}
      and h.url_path = {{urlPath}}
      ${urlHostnameFilter}
      and h.created_at between {{startDate}} and {{endDate}}
      ${filterContext.filterQuery}
      and h.x is not null
      and h.y is not null
      and h.page_x is not null
      and h.page_y is not null
      and h.page_w is not null
      and h.page_h is not null
      and h.viewport_w is not null
      and h.viewport_h is not null
    group by
      h.x,
      h.y,
      h.page_x,
      h.page_y,
      h.page_w,
      h.page_h,
      h.viewport_w,
      h.viewport_h
    order by count desc
    limit ${POINT_LIMIT}
    `,
    { ...filterContext.queryParams, ...urlHostnameParams, websiteId, eventType, urlPath, startDate, endDate },
    FUNCTION_NAME,
  );

  const viewport = pickSnapshotViewport(rawPoints);
  const snapshot = await resolveHeatmapSnapshot({
    websiteId,
    urlPath,
    hostname: urlHostname || getSnapshotHostname(parameters),
    viewportW: viewport?.width ?? null,
    viewportH: viewport?.height ?? null,
    pageW: viewport?.pageW ?? null,
    pageH: viewport?.pageH ?? null,
  });

  return { mode, pages, points: rawPoints, snapshot, scroll: emptyScroll() };
}

async function clickhouseQuery(
  websiteId: string,
  parameters: HeatmapParameters,
): Promise<HeatmapResult> {
  const { rawQuery } = clickhouse;
  const { startDate, endDate, urlPath, urlHostname, mode = 'click' } = parameters;
  const eventType = mode === 'scroll' ? HEATMAP_EVENT_TYPE.scroll : HEATMAP_EVENT_TYPE.click;
  const filterContext = getClickhouseHeatmapFilterContext(websiteId, parameters);
  // '' selects legacy rows recorded before src_hostname existed.
  const urlHostnameFilter =
    urlHostname === undefined
      ? ''
      : urlHostname
        ? 'and h.src_hostname = {urlHostname:String}'
        : "and h.src_hostname = ''";
  const urlHostnameParams = urlHostname ? { urlHostname } : {};
  const pageFilter =
    mode === 'click'
      ? `
      and x is not null
      and y is not null
      and page_x is not null
      and page_y is not null
      and page_w is not null
      and page_h is not null
      and viewport_w is not null
      and viewport_h is not null
    `
      : `
      and scroll_pct is not null
      and page_w is not null
      and page_h is not null
      and viewport_w is not null
      and viewport_h is not null
    `;

  const pageRows = await rawQuery<
    {
      urlPath: string;
      hostname: string | null;
      count: string | number;
      sessions: string | number;
    }[]
  >(
    `
    select
      h.url_path as urlPath,
      h.src_hostname as hostname,
      count() as count,
      uniq(h.visit_id) as sessions
    from heatmap_event h
    ${filterContext.joinQuery}
    where h.website_id = {websiteId:UUID}
      and h.event_type = {eventType:UInt8}
      and h.created_at between {startDate:DateTime64} and {endDate:DateTime64}
      ${filterContext.filterQuery}
      ${pageFilter}
    group by h.url_path, h.src_hostname
    order by sessions desc, count desc
    limit ${PAGE_LIMIT}
    `,
    { ...filterContext.queryParams, websiteId, eventType, startDate, endDate },
    FUNCTION_NAME,
  );

  const pages: HeatmapPage[] = pageRows
    .map(p => ({
      urlPath: p.urlPath,
      hostname: p.hostname ?? '',
      count: Number(p.count),
      sessions: Number(p.sessions),
    }));

  if (!urlPath) {
    return { mode, pages, points: [], snapshot: null, scroll: emptyScroll() };
  }

  if (mode === 'scroll') {
    const bucketRows = await rawQuery<
      {
        depth: number | string;
        sessions: number | string;
        pageW: number | string;
        pageH: number | string;
        viewportW: number | string;
        viewportH: number | string;
      }[]
    >(
      `
      select
        intDiv(max_pct, ${SCROLL_BUCKET_SIZE}) * ${SCROLL_BUCKET_SIZE} as depth,
        count() as sessions,
        pageW,
        pageH,
        viewportW,
        viewportH
      from (
        select
          h.visit_id,
          max(h.scroll_pct) as max_pct,
          toInt32OrNull(toString(arrayElement(topK(1)(h.page_w), 1))) as pageW,
          toInt32OrNull(toString(arrayElement(topK(1)(h.page_h), 1))) as pageH,
          toInt32OrNull(toString(arrayElement(topK(1)(h.viewport_w), 1))) as viewportW,
          toInt32OrNull(toString(arrayElement(topK(1)(h.viewport_h), 1))) as viewportH
        from heatmap_event h
        ${filterContext.joinQuery}
        where h.website_id = {websiteId:UUID}
          and h.event_type = {eventType:UInt8}
          and h.url_path = {urlPath:String}
          ${urlHostnameFilter}
          and h.created_at between {startDate:DateTime64} and {endDate:DateTime64}
          ${filterContext.filterQuery}
          and h.scroll_pct is not null
          and h.page_w is not null
          and h.page_h is not null
          and h.viewport_w is not null
          and h.viewport_h is not null
        group by h.visit_id
      )
      where pageW is not null
        and pageH is not null
        and viewportW is not null
        and viewportH is not null
      group by depth, pageW, pageH, viewportW, viewportH
      order by depth
      `,
      { ...filterContext.queryParams, ...urlHostnameParams, websiteId, eventType, urlPath, startDate, endDate },
      FUNCTION_NAME,
    );

    const scrollBuckets = bucketRows.map(r => ({
      depth: Number(r.depth),
      sessions: Number(r.sessions),
      pageW: Number(r.pageW),
      pageH: Number(r.pageH),
      viewportW: Number(r.viewportW),
      viewportH: Number(r.viewportH),
    }));
    const viewport = pickScrollSnapshotViewport(scrollBuckets);
    const scroll = {
      buckets: scrollBuckets,
      totalSessions: scrollBuckets.reduce((sum, bucket) => sum + bucket.sessions, 0),
      pageW: viewport?.pageW ?? null,
      pageH: viewport?.pageH ?? null,
      viewportW: viewport?.width ?? null,
      viewportH: viewport?.height ?? null,
    };
    const snapshot = await resolveHeatmapSnapshot({
      websiteId,
      urlPath,
      hostname: urlHostname || getSnapshotHostname(parameters),
      viewportW: viewport?.width ?? null,
      viewportH: viewport?.height ?? null,
      pageW: viewport?.pageW ?? null,
      pageH: viewport?.pageH ?? null,
    });

    return {
      mode,
      pages,
      points: [],
      snapshot,
      scroll,
    };
  }

  const pointRows = await rawQuery<
    {
      x: number;
      y: number;
      pageX: number;
      pageY: number;
      pageW: number;
      pageH: number;
      viewportW: number;
      viewportH: number;
      count: string | number;
    }[]
  >(
    `
    select
      h.x,
      h.y,
      h.page_x as pageX,
      h.page_y as pageY,
      h.page_w as pageW,
      h.page_h as pageH,
      h.viewport_w as viewportW,
      h.viewport_h as viewportH,
      count() as count
    from heatmap_event h
    ${filterContext.joinQuery}
    where h.website_id = {websiteId:UUID}
      and h.event_type = {eventType:UInt8}
      and h.url_path = {urlPath:String}
      ${urlHostnameFilter}
      and h.created_at between {startDate:DateTime64} and {endDate:DateTime64}
      ${filterContext.filterQuery}
      and h.x is not null
      and h.y is not null
      and h.page_x is not null
      and h.page_y is not null
      and h.page_w is not null
      and h.page_h is not null
      and h.viewport_w is not null
      and h.viewport_h is not null
    group by
      h.x,
      h.y,
      h.page_x,
      h.page_y,
      h.page_w,
      h.page_h,
      h.viewport_w,
      h.viewport_h
    order by count desc
    limit ${POINT_LIMIT}
    `,
    { ...filterContext.queryParams, ...urlHostnameParams, websiteId, eventType, urlPath, startDate, endDate },
    FUNCTION_NAME,
  );

  const points: HeatmapPoint[] = pointRows.map(p => ({
    x: Number(p.x),
    y: Number(p.y),
    pageX: Number(p.pageX),
    pageY: Number(p.pageY),
    pageW: Number(p.pageW),
    pageH: Number(p.pageH),
    viewportW: Number(p.viewportW),
    viewportH: Number(p.viewportH),
    count: Number(p.count),
  }));

  const viewport = pickSnapshotViewport(points);
  const snapshot = await resolveHeatmapSnapshot({
    websiteId,
    urlPath,
    hostname: urlHostname || getSnapshotHostname(parameters),
    viewportW: viewport?.width ?? null,
    viewportH: viewport?.height ?? null,
    pageW: viewport?.pageW ?? null,
    pageH: viewport?.pageH ?? null,
  });

  return { mode, pages, points, snapshot, scroll: emptyScroll() };
}

function emptyScroll(): HeatmapResult['scroll'] {
  return {
    buckets: [],
    totalSessions: 0,
    pageW: null,
    pageH: null,
    viewportW: null,
    viewportH: null,
  };
}

async function resolveHeatmapSnapshot({
  websiteId,
  urlPath,
  hostname,
  viewportW,
  viewportH,
  pageW,
  pageH,
}: {
  websiteId: string;
  urlPath: string;
  hostname: string | null;
  viewportW: number | null;
  viewportH: number | null;
  pageW: number | null;
  pageH: number | null;
}): Promise<HeatmapSnapshot | null> {
  return getIframeSnapshot({
    websiteId,
    urlPath,
    hostname,
    viewportW,
    viewportH,
    pageW,
    pageH,
  });
}

async function getIframeSnapshot({
  websiteId,
  urlPath,
  hostname,
  viewportW,
  viewportH,
  pageW,
  pageH,
}: {
  websiteId: string;
  urlPath: string;
  hostname: string | null;
  viewportW: number | null;
  viewportH: number | null;
  pageW: number | null;
  pageH: number | null;
}): Promise<HeatmapSnapshotIframe | null> {
  if (!urlPath || !viewportW || !pageW || !pageH) {
    return null;
  }

  const website = await getWebsite(websiteId);
  const url = buildHeatmapPageUrl(website?.domain, urlPath, hostname);

  if (!url) {
    return null;
  }

  const fallbackViewportH = Math.min(Math.max(pageH, 640), 1080);
  const height = viewportH || fallbackViewportH;

  return {
    kind: 'iframe',
    id: `iframe:${websiteId}:${urlPath}:${viewportW}x${height}`,
    url,
    pageW,
    pageH,
    viewportW,
    viewportH: height,
  };
}

function getDomainList(domain?: string | null) {
  return (
    domain
      ?.split(',')
      .map(entry => entry.trim())
      .filter(Boolean) ?? []
  );
}

function getDomainHost(entry: string) {
  try {
    const url =
      entry.startsWith('http://') || entry.startsWith('https://')
        ? new URL(entry)
        : new URL(`https://${entry}`);

    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function getWebsiteOrigin(domain?: string | null, hostname?: string | null) {
  const entries = getDomainList(domain);
  // Only render a hostname that matches, or is a subdomain of, one of the
  // website's configured domains so the iframe cannot be pointed at an
  // arbitrary host via a crafted filter.
  const requested = hostname?.toLowerCase();
  // An exact match uses the configured entry (it may carry a protocol or
  // port); a subdomain match uses the requested hostname itself.
  const exactEntry = requested
    ? entries.find(entry => getDomainHost(entry) === requested)
    : undefined;
  const subdomainMatch =
    requested && !exactEntry
      ? entries.some(entry => requested.endsWith(`.${getDomainHost(entry)}`))
      : false;
  const host = exactEntry ?? (subdomainMatch ? requested : undefined) ?? entries[0];

  if (!host) {
    return null;
  }

  if (host.startsWith('http://') || host.startsWith('https://')) {
    return new URL(host);
  }

  const protocol =
    host.startsWith('localhost') || host.startsWith('127.0.0.1') || host.startsWith('[::1]')
      ? 'http'
      : 'https';

  return new URL(`${protocol}://${host}`);
}

function buildHeatmapPageUrl(
  domain: string | null | undefined,
  urlPath: string,
  hostname?: string | null,
) {
  try {
    const origin = getWebsiteOrigin(domain, hostname);

    if (!origin) {
      return null;
    }

    return new URL(urlPath || '/', origin).toString();
  } catch {
    return null;
  }
}

function getSnapshotHostname(filters: QueryFilters): string | null {
  const filter = filtersObjectToArray(filters).find(
    f => f.name === 'hostname' && f.operator === OPERATORS.equals,
  );
  const value = Array.isArray(filter?.value) ? filter.value[0] : filter?.value;

  return typeof value === 'string' && value ? value : null;
}

// Pick the value with the highest total weight (smallest value wins ties) so a
// single outlier measurement cannot stretch the rendered page.
function pickModalValue(counts: Map<number, number>) {
  let best = 0;
  let bestWeight = -1;

  for (const [value, weight] of counts) {
    if (weight > bestWeight || (weight === bestWeight && value < best)) {
      best = value;
      bestWeight = weight;
    }
  }

  return best;
}

function addWeight(counts: Map<number, number>, value: number, weight: number) {
  counts.set(value, (counts.get(value) ?? 0) + weight);
}

function pickSnapshotViewport(
  points: HeatmapPoint[],
): { width: number; height: number; pageW: number; pageH: number } | null {
  const viewportBuckets = new Map<
    string,
    {
      width: number;
      height: number;
      count: number;
      pageWCounts: Map<number, number>;
      pageHCounts: Map<number, number>;
    }
  >();

  for (const p of points) {
    const viewportKey = `${p.viewportW}x${p.viewportH}`;
    let viewportBucket = viewportBuckets.get(viewportKey);

    if (!viewportBucket) {
      viewportBucket = {
        width: p.viewportW,
        height: p.viewportH,
        count: 0,
        pageWCounts: new Map(),
        pageHCounts: new Map(),
      };
      viewportBuckets.set(viewportKey, viewportBucket);
    }

    viewportBucket.count += p.count;
    addWeight(viewportBucket.pageWCounts, p.pageW, p.count);
    addWeight(viewportBucket.pageHCounts, p.pageH, p.count);
  }

  let bestViewport: (typeof viewportBuckets extends Map<string, infer V> ? V : never) | null =
    null;

  for (const bucket of viewportBuckets.values()) {
    if (!bestViewport || bucket.count > bestViewport.count) {
      bestViewport = bucket;
    }
  }

  if (!bestViewport) {
    return null;
  }

  return {
    width: bestViewport.width,
    height: bestViewport.height,
    pageW: pickModalValue(bestViewport.pageWCounts),
    pageH: pickModalValue(bestViewport.pageHCounts),
  };
}

function pickScrollSnapshotViewport(
  buckets: HeatmapScrollBucket[],
): { width: number; height: number; pageW: number; pageH: number } | null {
  const viewportBuckets = new Map<
    string,
    {
      width: number;
      height: number;
      sessions: number;
      pageWCounts: Map<number, number>;
      pageHCounts: Map<number, number>;
    }
  >();

  for (const bucket of buckets) {
    const viewportKey = `${bucket.viewportW}x${bucket.viewportH}`;
    let viewportBucket = viewportBuckets.get(viewportKey);

    if (!viewportBucket) {
      viewportBucket = {
        width: bucket.viewportW,
        height: bucket.viewportH,
        sessions: 0,
        pageWCounts: new Map(),
        pageHCounts: new Map(),
      };
      viewportBuckets.set(viewportKey, viewportBucket);
    }

    viewportBucket.sessions += bucket.sessions;
    addWeight(viewportBucket.pageWCounts, bucket.pageW, bucket.sessions);
    addWeight(viewportBucket.pageHCounts, bucket.pageH, bucket.sessions);
  }

  let bestViewport: (typeof viewportBuckets extends Map<string, infer V> ? V : never) | null =
    null;

  for (const bucket of viewportBuckets.values()) {
    if (!bestViewport || bucket.sessions > bestViewport.sessions) {
      bestViewport = bucket;
    }
  }

  if (!bestViewport) {
    return null;
  }

  return {
    width: bestViewport.width,
    height: bestViewport.height,
    pageW: pickModalValue(bestViewport.pageWCounts),
    pageH: pickModalValue(bestViewport.pageHCounts),
  };
}

// Filters applied directly to heatmap_event columns instead of through the
// visit-level website_event join. src_hostname is a fork-local column.
const HEATMAP_DIRECT_COLUMNS: Record<string, string> = {
  path: 'url_path',
  hostname: 'src_hostname',
};

function getHeatmapDirectFilters(filters: QueryFilters) {
  return filtersObjectToArray(filters).filter(filter => HEATMAP_DIRECT_COLUMNS[filter.name]);
}

function omitHeatmapDirectFilters(filters: QueryFilters): QueryFilters {
  return Object.fromEntries(
    Object.entries(filters).filter(([key]) => !HEATMAP_DIRECT_COLUMNS[key.replace(/\d+$/, '')]),
  ) as QueryFilters;
}

function getRelationalHeatmapDirectFilterContext(filters: QueryFilters) {
  const directFilters = getHeatmapDirectFilters(filters);

  if (!directFilters.length) {
    return { filterQuery: '', queryParams: {} };
  }

  const clauses = directFilters.map(({ operator, paramName, name }) => {
    const key = paramName ?? name;
    const column = `h.${HEATMAP_DIRECT_COLUMNS[name]}`;

    switch (operator) {
      case OPERATORS.equals:
        return `${column} = ANY({{${key}}})`;
      case OPERATORS.notEquals:
        return `${column} != ALL({{${key}}})`;
      case OPERATORS.contains:
        return `${column} ilike {{${key}}}`;
      case OPERATORS.doesNotContain:
        return `${column} not ilike {{${key}}}`;
      case OPERATORS.regex:
        return `${column} ~* {{${key}}}`;
      case OPERATORS.notRegex:
        return `${column} !~* {{${key}}}`;
      default:
        return '';
    }
  });

  const queryParams = Object.fromEntries(
    directFilters.map(({ operator, value, paramName, name }) => {
      const key = paramName ?? name;

      if (operator === OPERATORS.contains || operator === OPERATORS.doesNotContain) {
        return [key, `%${value}%`];
      }

      if (operator === OPERATORS.equals || operator === OPERATORS.notEquals) {
        return [key, Array.isArray(value) ? value : [value]];
      }

      return [key, Array.isArray(value) ? value[0] : value];
    }),
  );

  const joinedClauses =
    filters.match === 'any'
      ? clauses.filter(Boolean).join('\n        or ')
      : clauses.filter(Boolean).join('\n      and ');

  return {
    filterQuery:
      filters.match === 'any'
        ? `and (\n        ${joinedClauses}\n      )`
        : clauses.length
          ? `and ${joinedClauses}`
          : '',
    queryParams,
  };
}

function getClickhouseHeatmapDirectFilterContext(filters: QueryFilters) {
  const directFilters = getHeatmapDirectFilters(filters);

  if (!directFilters.length) {
    return { filterQuery: '', queryParams: {} };
  }

  const clauses = directFilters.map(({ operator, paramName, name }) => {
    const key = paramName ?? name;
    const column = `h.${HEATMAP_DIRECT_COLUMNS[name]}`;

    switch (operator) {
      case OPERATORS.equals:
        return `${column} IN {${key}:Array(String)}`;
      case OPERATORS.notEquals:
        return `${column} NOT IN {${key}:Array(String)}`;
      case OPERATORS.contains:
        return `positionCaseInsensitive(${column}, {${key}:String}) > 0`;
      case OPERATORS.doesNotContain:
        return `positionCaseInsensitive(${column}, {${key}:String}) = 0`;
      case OPERATORS.regex:
        return `match(${column}, concat('(?i)', {${key}:String}))`;
      case OPERATORS.notRegex:
        return `not match(${column}, concat('(?i)', {${key}:String}))`;
      default:
        return '';
    }
  });

  const queryParams = Object.fromEntries(
    directFilters.map(({ operator, value, paramName, name }) => {
      const key = paramName ?? name;

      if (operator === OPERATORS.equals || operator === OPERATORS.notEquals) {
        return [key, Array.isArray(value) ? value : [value]];
      }

      return [key, Array.isArray(value) ? value[0] : value];
    }),
  );

  const joinedClauses =
    filters.match === 'any'
      ? clauses.filter(Boolean).join('\n        or ')
      : clauses.filter(Boolean).join('\n      and ');

  return {
    filterQuery:
      filters.match === 'any'
        ? `and (\n        ${joinedClauses}\n      )`
        : clauses.length
          ? `and ${joinedClauses}`
          : '',
    queryParams,
  };
}

function getRelationalHeatmapFilterContext(
  websiteId: string,
  filters: QueryFilters,
): HeatmapFilterContext {
  const { parseFilters } = prisma;
  const pathFilterContext = getRelationalHeatmapDirectFilterContext(filters);
  const { filterQuery, cohortQuery, excludeBounceQuery, joinSessionQuery, queryParams } =
    parseFilters({
      ...omitHeatmapDirectFilters(filters),
      websiteId,
    });

  if (!(filterQuery || cohortQuery || excludeBounceQuery)) {
    return {
      joinQuery: '',
      filterQuery: pathFilterContext.filterQuery,
      queryParams: pathFilterContext.queryParams,
    };
  }

  return {
    joinQuery: `
    inner join (
      select distinct website_event.website_id, website_event.session_id, website_event.visit_id
      from website_event
      ${joinSessionQuery}
      ${cohortQuery}
      ${excludeBounceQuery}
      where website_event.website_id = {{websiteId::uuid}}
        and website_event.created_at between {{startDate}} and {{endDate}}
        ${filterQuery}
    ) filtered_visits
      on filtered_visits.website_id = h.website_id
      and filtered_visits.session_id = h.session_id
      and filtered_visits.visit_id = h.visit_id
    `,
    filterQuery: pathFilterContext.filterQuery,
    queryParams: { ...queryParams, ...pathFilterContext.queryParams },
  };
}

function getClickhouseHeatmapFilterContext(
  websiteId: string,
  filters: QueryFilters,
): HeatmapFilterContext {
  const { parseFilters } = clickhouse;
  const pathFilterContext = getClickhouseHeatmapDirectFilterContext(filters);
  const { filterQuery, cohortQuery, excludeBounceQuery, queryParams } = parseFilters({
    ...omitHeatmapDirectFilters(filters),
    websiteId,
  });

  if (!(filterQuery || cohortQuery || excludeBounceQuery)) {
    return {
      joinQuery: '',
      filterQuery: pathFilterContext.filterQuery,
      queryParams: pathFilterContext.queryParams,
    };
  }

  return {
    joinQuery: `
    inner join (
      select distinct website_id, session_id, visit_id
      from website_event
      ${cohortQuery}
      ${excludeBounceQuery}
      where website_id = {websiteId:UUID}
        and created_at between {startDate:DateTime64} and {endDate:DateTime64}
        ${filterQuery}
    ) filtered_visits
      on filtered_visits.website_id = h.website_id
      and filtered_visits.session_id = h.session_id
      and filtered_visits.visit_id = h.visit_id
    `,
    filterQuery: pathFilterContext.filterQuery,
    queryParams: { ...queryParams, ...pathFilterContext.queryParams },
  };
}
