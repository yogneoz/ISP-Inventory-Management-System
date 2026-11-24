/**
 * Canonical demo integration fixtures: one subscription-portal partner, the API
 * key it authenticates with, and a couple of queued events.
 *
 * This is what the Integration Partners and API Keys screens read. Nothing here
 * posts a journal or moves stock: the partner row is an agreement, and the
 * outbox rows are events that were never delivered because the partner has no
 * webhook URL — which is exactly the state the delivery worker leaves them in.
 */
import crypto from 'node:crypto';
import { insertRows, type Row } from './fixtureUtils';

const SEED = 'seed:verify';

/** The key the partner would present; only its hash is stored, as in the app. */
export const DEMO_PARTNER_KEY_PREFIX = 'isp_live_demo_portal';
export const DEMO_PARTNER_SECRET = 'demo-portal-shared-secret';
export const DEMO_PARTNER_ID = 'ptn-demo-subscription-portal';
export const DEMO_PARTNER_API_KEY_ID = 'bbbbbbbb-0000-4000-8000-000000000001';

export interface DemoIntegrationFixtures {
  apiKeys: Row[];
  partners: Row[];
  outbox: Row[];
}

export function buildDemoIntegrationFixtures(): DemoIntegrationFixtures {
  const apiKeys: Row[] = [
    {
      id: DEMO_PARTNER_API_KEY_ID,
      name: 'Subscription portal (demo)',
      description: 'Reads customer records, asks for a service invoice, reports a subscription payment.',
      key_prefix: DEMO_PARTNER_KEY_PREFIX,
      secret_hash: crypto.createHash('sha256').update(DEMO_PARTNER_SECRET).digest('hex'),
      operations: ['partner.customers.read', 'partner.service-invoice.write', 'partner.payment.write'],
      read_only: false,
      branch_ids: ['BR-KTM', 'BR-PKR', 'BR-BTL', 'BR-DHN'],
      rpm_limit: 600,
      cidr_allowlist: [],
      created_by: SEED,
      created_by_email: 'superadmin@example.com',
    },
  ];

  const partners: Row[] = [
    {
      id: DEMO_PARTNER_ID,
      code: 'SUBS-PORTAL',
      name: 'Subscription Portal (demo)',
      contract_version: 'v1',
      api_key_id: DEMO_PARTNER_API_KEY_ID,
      status: 'ACTIVE',
      allowed_events: ['service_invoice.posted', 'subscription_payment.received'],
      // No webhook URL: the delivery worker keeps events queued instead of
      // dropping them, which is the state the outbox screen demonstrates.
      webhook_url: null,
      webhook_secret: null,
      created_by: SEED,
    },
  ];

  const outbox: Row[] = [
    {
      id: 'bbbbbbbb-0000-4000-8000-000000000101',
      partner_id: DEMO_PARTNER_ID,
      event: 'service_invoice.posted',
      entity: 'service_invoices',
      entity_id: 'demo-service-invoice-001',
      payload: JSON.stringify({
        invoiceNumber: 'SI-DEMO-0001',
        customerCode: 'CUS-KTM-01',
        planName: 'Home Fibre 100 Mbps',
        total: 1180,
        currency: 'NPR',
      }),
      status: 'PENDING',
      attempts: 0,
      next_attempt_at: '2026-11-24T04:00:00Z',
      last_error: null,
      created_at: '2026-11-23T09:00:00Z',
    },
    {
      id: 'bbbbbbbb-0000-4000-8000-000000000102',
      partner_id: DEMO_PARTNER_ID,
      event: 'subscription_payment.received',
      entity: 'customer_payments',
      entity_id: 'demo-sync-payment-001',
      payload: JSON.stringify({ customerCode: 'CUS-PKR-03', amount: 1180, method: 'ESEWA' }),
      status: 'FAILED',
      attempts: 2,
      next_attempt_at: '2026-11-24T05:30:00Z',
      last_error: 'Partner has no webhook URL configured.',
      created_at: '2026-11-23T10:15:00Z',
    },
  ];

  return { apiKeys, partners, outbox };
}

export async function applyDemoIntegrationFixtures(client: any): Promise<Record<string, number>> {
  const fixtures = buildDemoIntegrationFixtures();
  const summary: Record<string, number> = {};
  const put = async (key: string, table: string, columns: string[], rows: Row[]) => {
    summary[key] = rows.length;
    await insertRows(client, table, columns, rows);
  };

  await put('demoApiKeys', 'api_keys',
    ['id', 'name', 'description', 'key_prefix', 'secret_hash', 'operations', 'read_only', 'branch_ids',
      'rpm_limit', 'cidr_allowlist', 'created_by', 'created_by_email'],
    fixtures.apiKeys);
  await put('demoPartners', 'integration_partners',
    ['id', 'code', 'name', 'contract_version', 'api_key_id', 'status', 'allowed_events', 'webhook_url',
      'webhook_secret', 'created_by'],
    fixtures.partners);
  await put('demoIntegrationOutbox', 'integration_outbox',
    ['id', 'partner_id', 'event', 'entity', 'entity_id', 'payload', 'status', 'attempts', 'next_attempt_at',
      'last_error', 'created_at'],
    fixtures.outbox);

  return summary;
}
