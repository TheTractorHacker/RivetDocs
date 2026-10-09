import { z } from 'zod';
import type { DriverDescriptor, SourceFieldDto, SourceOrgDto } from '@rivetdocs/shared';
import {
  DriverAuthError,
  type FetchRecordsContext,
  type IntegrationContext,
  type IntegrationDriver,
  type LegacyDriverFetchPage,
  type LegacyDriverRecord,
} from '../integration-driver.js';
import { fetchWithRetry, sortByLabel } from '../driver-utils.js';

/**
 * RivetIT / RivetMSP edition driver.
 *
 * Both editions serve the same read endpoints under `/api/v1`
 * (`/clients`, `/assets`, `/contacts`), so one implementation backs two
 * registry keys (`rivetit`, `rivetmsp`): operators connect either
 * edition, or both at once as separate integrations.
 *
 *   source org  = an edition client (`GET /clients`)
 *   `assets`    = `GET /assets?client_id=N`   (max 50 per page)
 *   `contacts`  = `GET /contacts?client_id=N` (max 100 per page)
 *
 * Auth: the edition's instance API key in `X-Api-Key`. Credentials are
 * never requested or synced: the edition denies the legacy key on
 * `/credentials` by design, and RivetDocs keeps its own vault.
 *
 * Paging: the cursor is the next 1-based page number. Edition list
 * endpoints answer `{ data: [...], total }`.
 */

export const RIVET_EDITION_RESOURCE_ASSETS = 'assets' as const;
export const RIVET_EDITION_RESOURCE_CONTACTS = 'contacts' as const;

const PAGE_SIZE = { assets: 50, contacts: 100, clients: 100 } as const;
const MAX_PAGES = 1_000;

const configSchema = z.object({
  baseUrl: z.string().url(),
});

const secretSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
});

export type RivetEdition = 'rivetit' | 'rivetmsp';

const EDITION_LABEL: Record<RivetEdition, string> = {
  rivetit: 'RivetIT',
  rivetmsp: 'RivetMSP',
};

interface ListPage<T> {
  data?: T[];
  total?: number;
}

interface EditionClient {
  id?: number | string;
  name?: string;
  city?: string | null;
  state?: string | null;
}

type EditionRow = Record<string, unknown>;

export class RivetEditionDriver implements IntegrationDriver {
  readonly key: RivetEdition;
  readonly descriptor: DriverDescriptor;
  private readonly label: string;

  constructor(edition: RivetEdition) {
    this.key = edition;
    this.label = EDITION_LABEL[edition];
    this.descriptor = {
      key: edition,
      label: this.label,
      description: `Sync ${this.label} clients, assets and contacts into RivetDocs. Passwords are never synced.`,
      iconKey: null,
      configFields: [
        {
          key: 'baseUrl',
          label: 'Instance URL',
          kind: 'url',
          required: true,
          description: `Base URL of your ${this.label} install, for example https://itflow.example.com`,
        },
      ],
      secretFields: [
        {
          key: 'apiKey',
          label: 'API Key',
          kind: 'password',
          required: true,
          description: `${this.label} instance API key (Admin > API). Stored AES-256-GCM encrypted; never returned to the UI.`,
        },
      ],
      resources: [
        {
          key: RIVET_EDITION_RESOURCE_ASSETS,
          label: 'Assets',
          targetKind: 'asset',
          targetConfig: {},
          dependsOnResourceKeys: [],
          description: `Devices and assets recorded against each mapped ${this.label} client.`,
          defaultMatchKeyHint: 'serial',
        },
        {
          key: RIVET_EDITION_RESOURCE_CONTACTS,
          label: 'Contacts',
          targetKind: 'asset',
          targetConfig: {},
          dependsOnResourceKeys: [],
          description: `People recorded against each mapped ${this.label} client.`,
          defaultMatchKeyHint: 'email',
        },
      ],
      capabilities: {
        kind: 'pull',
        listSourceOrgs: true,
        dryRun: true,
        ticketing: false,
        reconstructionCompleteness: false,
      },
    };
  }

  validateConfiguration(
    config: Record<string, unknown> | null | undefined,
    secret: Record<string, unknown> | null | undefined,
  ): void {
    configSchema.parse(config ?? {});
    if (secret) secretSchema.parse(secret);
  }

  async testConnection(ctx: IntegrationContext): Promise<{ ok: true; details?: string }> {
    const page = await this.getPage<EditionClient>(ctx, 'clients', 1, 1);
    const total = typeof page.total === 'number' ? page.total : (page.data?.length ?? 0);
    return {
      ok: true,
      details: `Reached ${this.label} (${total} client${total === 1 ? '' : 's'} visible).`,
    };
  }

  async listSourceOrgs(ctx: IntegrationContext): Promise<SourceOrgDto[]> {
    const out: SourceOrgDto[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await this.getPage<EditionClient>(ctx, 'clients', page, PAGE_SIZE.clients);
      const rows = body.data ?? [];
      for (const c of rows) {
        const id = idString(c.id);
        if (!id) continue;
        const place = [c.city, c.state].filter(Boolean).join(', ');
        out.push({
          externalId: id,
          name: c.name?.trim() || `Client ${id}`,
          hint: place || null,
        });
      }
      if (!hasMore(body, page, PAGE_SIZE.clients, rows.length)) break;
    }
    return out;
  }

  async listSourceFields(
    ctx: IntegrationContext & { externalOrgId: string; resourceKey: string },
  ): Promise<SourceFieldDto[]> {
    return sortByLabel([
      ...(ctx.resourceKey === RIVET_EDITION_RESOURCE_CONTACTS ? CONTACT_FIELDS : ASSET_FIELDS),
    ]);
  }

  async fetchRecords(
    ctx: FetchRecordsContext,
    cursor: string | null,
  ): Promise<LegacyDriverFetchPage> {
    const isContacts = ctx.resourceKey === RIVET_EDITION_RESOURCE_CONTACTS;
    const resource = isContacts ? 'contacts' : 'assets';
    const size = PAGE_SIZE[resource];
    const page = parseCursor(cursor);
    const body = await this.getPage<EditionRow>(ctx, resource, page, size, {
      client_id: ctx.externalOrgId,
    });
    const rows = body.data ?? [];

    const records: LegacyDriverRecord[] = [];
    for (const row of rows) {
      const externalId = idString(row.id);
      if (!externalId) continue;
      records.push({
        externalId,
        displayName: firstString(row.name, row.serial, row.email) ?? null,
        fields: flatten(row),
        updatedAt: null,
      });
    }
    const more = hasMore(body, page, size, rows.length);
    return { records, hasMore: more, cursor: more ? String(page + 1) : null };
  }

  private async getPage<T>(
    ctx: IntegrationContext,
    resource: 'clients' | 'assets' | 'contacts',
    page: number,
    limit: number,
    extra: Record<string, string> = {},
  ): Promise<ListPage<T>> {
    const { baseUrl } = configSchema.parse(ctx.config ?? {});
    const { apiKey } = secretSchema.parse(ctx.secret ?? {});
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/api/v1/${resource}`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', String(limit));
    for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);

    const res = await fetchWithRetry(url.toString(), {
      method: 'GET',
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      timeoutMs: ctx.http.timeoutMs,
      maxRetries: ctx.http.maxRetries,
      backoffMs: ctx.http.backoffMs,
      correlationId: ctx.correlationId,
      serviceName: this.label,
    });
    if (res.status === 401 || res.status === 403) {
      throw new DriverAuthError(
        `${this.label} GET /api/v1/${resource} returned ${res.status}. Check the API key.`,
      );
    }
    if (!res.ok) {
      throw new Error(`${this.label} GET /api/v1/${resource} returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as unknown;
    // Some list endpoints return a bare array; treat that as a single page.
    if (Array.isArray(json)) return { data: json as T[], total: json.length };
    return (json ?? {}) as ListPage<T>;
  }
}

function parseCursor(cursor: string | null): number {
  const n = cursor ? Number.parseInt(cursor, 10) : 1;
  return Number.isFinite(n) && n >= 1 && n <= MAX_PAGES ? n : 1;
}

function hasMore(body: ListPage<unknown>, page: number, size: number, got: number): boolean {
  if (page >= MAX_PAGES || got === 0) return false;
  if (typeof body.total === 'number') return page * size < body.total;
  return got >= size;
}

function idString(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function flatten(row: EditionRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  return out;
}

const ASSET_FIELDS: SourceFieldDto[] = [
  { key: 'id', label: 'Edition asset ID', hintType: 'NUMBER', alwaysPresent: true },
  { key: 'name', label: 'Name', hintType: 'TEXT', alwaysPresent: true },
  { key: 'type', label: 'Type', hintType: 'TEXT', alwaysPresent: false },
  { key: 'make', label: 'Make', hintType: 'TEXT', alwaysPresent: false },
  { key: 'model', label: 'Model', hintType: 'TEXT', alwaysPresent: false },
  { key: 'serial', label: 'Serial number', hintType: 'TEXT', alwaysPresent: false },
  { key: 'os', label: 'Operating system', hintType: 'TEXT', alwaysPresent: false },
  { key: 'status', label: 'Status', hintType: 'TEXT', alwaysPresent: false },
  { key: 'client', label: 'Client name', hintType: 'TEXT', alwaysPresent: false },
];

const CONTACT_FIELDS: SourceFieldDto[] = [
  { key: 'id', label: 'Edition contact ID', hintType: 'NUMBER', alwaysPresent: true },
  { key: 'name', label: 'Name', hintType: 'TEXT', alwaysPresent: true },
  { key: 'title', label: 'Title', hintType: 'TEXT', alwaysPresent: false },
  { key: 'email', label: 'Email', hintType: 'EMAIL', alwaysPresent: false },
  { key: 'phone', label: 'Phone', hintType: 'TEXT', alwaysPresent: false },
  { key: 'extension', label: 'Extension', hintType: 'TEXT', alwaysPresent: false },
  { key: 'client', label: 'Client name', hintType: 'TEXT', alwaysPresent: false },
];
