import {
  DriverAuthError,
  type FetchRecordsContext,
  type IntegrationContext,
} from '../integration-driver.js';
import { RivetEditionDriver } from './rivetedition.driver.js';
import {
  setDefaultFetchForTests,
  setDefaultResolveForTests,
} from '../../../common/egress/safe-fetch.js';

/**
 * RivetIT / RivetMSP edition driver tests. A scripted `fetch` shim stands
 * in for the edition's `/api/v1` so we can pin the auth header, the
 * `client_id` scoping, page-number cursors and the 401/403 mapping.
 */

interface Call {
  url: string;
  headers?: Record<string, string>;
}

function install(script: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  setDefaultFetchForTests((async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: init?.headers as Record<string, string> });
    const next = script[i++];
    if (!next) throw new Error('unscripted fetch');
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch);
  setDefaultResolveForTests(async () => ['1.2.3.4']);
  return {
    calls,
    restore: () => {
      setDefaultFetchForTests(null);
      setDefaultResolveForTests(null);
    },
  };
}

const ctx = (): IntegrationContext =>
  ({
    integrationId: 'int-1',
    config: { baseUrl: 'https://docs.example.com/' },
    secret: { apiKey: 'secret-key' },
    correlationId: 'c',
    http: { timeoutMs: 5_000, maxRetries: 0, backoffMs: 1 },
  }) as IntegrationContext;

const fetchCtx = (resourceKey: string): FetchRecordsContext =>
  ({ ...ctx(), externalOrgId: '7', resourceKey, filter: {} }) as FetchRecordsContext;

describe('RivetEditionDriver', () => {
  it('registers under the edition key with edition-specific copy', () => {
    expect(new RivetEditionDriver('rivetit').descriptor.label).toBe('RivetIT');
    expect(new RivetEditionDriver('rivetmsp').key).toBe('rivetmsp');
  });

  it('lists clients as source orgs, sends the key header, and pages by total', async () => {
    const fx = install([
      { body: { data: [{ id: 1, name: 'Acme', city: 'Peoria', state: 'IL' }], total: 2 } },
      { body: { data: [{ id: 2, name: 'Globex' }], total: 2 } },
    ]);
    try {
      // size 100 > total 2, so a single page ends the walk
      const orgs = await new RivetEditionDriver('rivetit').listSourceOrgs(ctx());
      expect(orgs).toEqual([{ externalId: '1', name: 'Acme', hint: 'Peoria, IL' }]);
      expect(fx.calls).toHaveLength(1);
      expect(fx.calls[0]!.url).toBe('https://docs.example.com/api/v1/clients?page=1&limit=100');
      expect(fx.calls[0]!.headers?.['X-Api-Key']).toBe('secret-key');
    } finally {
      fx.restore();
    }
  });

  it('scopes asset fetches to the client and advances the page cursor', async () => {
    const rows = Array.from({ length: 50 }, (_, n) => ({
      id: n + 1,
      name: `A${n}`,
      serial: `S${n}`,
    }));
    const fx = install([
      { body: { data: rows, total: 60 } },
      { body: { data: [{ id: 51, name: 'Z' }], total: 60 } },
    ]);
    try {
      const d = new RivetEditionDriver('rivetmsp');
      const p1 = await d.fetchRecords(fetchCtx('assets'), null);
      expect(p1.records).toHaveLength(50);
      expect(p1.hasMore).toBe(true);
      expect(p1.cursor).toBe('2');
      expect(p1.records[0]).toMatchObject({ externalId: '1', displayName: 'A0' });
      expect(fx.calls[0]!.url).toContain('/api/v1/assets?page=1&limit=50&client_id=7');

      const p2 = await d.fetchRecords(fetchCtx('assets'), p1.cursor);
      expect(p2.hasMore).toBe(false);
      expect(p2.cursor).toBeNull();
      expect(fx.calls[1]!.url).toContain('page=2');
    } finally {
      fx.restore();
    }
  });

  it('fetches contacts from /contacts', async () => {
    const fx = install([{ body: { data: [{ id: 9, name: 'Pat', email: 'pat@x.io' }], total: 1 } }]);
    try {
      const page = await new RivetEditionDriver('rivetit').fetchRecords(fetchCtx('contacts'), null);
      expect(fx.calls[0]!.url).toContain('/api/v1/contacts?');
      expect(page.records[0]).toMatchObject({ externalId: '9', displayName: 'Pat' });
    } finally {
      fx.restore();
    }
  });

  it('maps 401/403 to DriverAuthError', async () => {
    const fx = install([{ status: 401, body: { error: 'nope' } }]);
    try {
      await expect(new RivetEditionDriver('rivetit').testConnection(ctx())).rejects.toBeInstanceOf(
        DriverAuthError,
      );
    } finally {
      fx.restore();
    }
  });
});
