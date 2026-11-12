/**
 * Company Overview card catalogue and role-level card ordering.
 *
 * The order is shared by every account with a role: a branch manager arranging
 * the page for their role changes the default branch-manager view, not another
 * role's. The catalogue lives here so the screen, the settings API and its
 * validation agree on the ids and the fallback order.
 */

export const COMPANY_OVERVIEW_CARD_IDS = [
  'finance',
  'inventory',
  'procurement',
  'warehouse',
  'liquidity',
  'budget',
  'sales',
  'hr',
] as const;

export type CompanyOverviewCardId = (typeof COMPANY_OVERVIEW_CARD_IDS)[number];

export const DEFAULT_COMPANY_OVERVIEW_CARD_ORDER: CompanyOverviewCardId[] = [
  ...COMPANY_OVERVIEW_CARD_IDS,
];

export const COMPANY_OVERVIEW_CARD_LABELS: Record<CompanyOverviewCardId, string> = {
  finance: 'Finance & Accounting',
  inventory: 'Inventory & Assets',
  procurement: 'Procurement & Supply',
  warehouse: 'Warehouse & In-Transit',
  liquidity: 'Cash & Liquidity',
  budget: 'Budget Health',
  sales: 'Sales & Customers',
  hr: 'People & HR',
};

/** Operations that open the Company Overview screen; the card order API uses
 * the same gate so a role that cannot read the page cannot change its order. */
export const COMPANY_OVERVIEW_ACCESS_OPERATIONS = [
  'prod-view',
  'stock-valuation',
  'assets-view',
  'fin-statements',
  'gl-view',
  'po-create',
  'inv-create',
  'shipment-history',
  'wh-receive-pullouts',
  'branch-transfer-receive',
  'sales-invoice-create',
  'customers-manage',
  'hr-employee-view',
  'gl-payroll-manage',
  'workflow-approval',
  'workflow-approval-cancel',
] as const;

function isCardId(value: unknown): value is CompanyOverviewCardId {
  return (
    typeof value === 'string' &&
    (COMPANY_OVERVIEW_CARD_IDS as readonly string[]).includes(value)
  );
}

/**
 * A safe, complete order from untrusted input: valid unique ids keep their
 * submitted order, then any card the payload omitted is appended in the
 * default order. A corrupt stored value can never hide a card.
 */
export function normalizeCompanyOverviewCardOrder(input: unknown): CompanyOverviewCardId[] {
  const out: CompanyOverviewCardId[] = [];
  for (const value of Array.isArray(input) ? input : []) {
    if (isCardId(value) && !out.includes(value)) out.push(value);
  }
  for (const id of DEFAULT_COMPANY_OVERVIEW_CARD_ORDER) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

const ROLE_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Parse the stored role → card-order map, dropping malformed entries. */
export function parseCompanyOverviewCardOrders(
  input: unknown
): Record<string, CompanyOverviewCardId[]> {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    if (!input.trim()) return {};
    try {
      parsed = JSON.parse(input);
    } catch {
      return {};
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

  const out: Record<string, CompanyOverviewCardId[]> = {};
  for (const [role, value] of Object.entries(parsed)) {
    if (!ROLE_KEY.test(role) || !Array.isArray(value)) continue;
    if (!value.some(isCardId)) continue;
    out[role] = normalizeCompanyOverviewCardOrder(value);
  }
  return out;
}

export function companyOverviewCardOrderForRole(
  stored: unknown,
  role: string | null | undefined
): CompanyOverviewCardId[] {
  if (!role) return [...DEFAULT_COMPANY_OVERVIEW_CARD_ORDER];
  const map = parseCompanyOverviewCardOrders(stored);
  return map[role] ? [...map[role]] : [...DEFAULT_COMPANY_OVERVIEW_CARD_ORDER];
}
