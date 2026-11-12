import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANY_OVERVIEW_CARD_IDS,
  DEFAULT_COMPANY_OVERVIEW_CARD_ORDER,
  companyOverviewCardOrderForRole,
  normalizeCompanyOverviewCardOrder,
  parseCompanyOverviewCardOrders,
} from '../shared/companyOverview';

describe('Company Overview role card order', () => {
  test('the default order contains every department once', () => {
    assert.deepEqual(DEFAULT_COMPANY_OVERVIEW_CARD_ORDER, [...COMPANY_OVERVIEW_CARD_IDS]);
    assert.equal(new Set(DEFAULT_COMPANY_OVERVIEW_CARD_ORDER).size, 8);
  });

  test('normalization keeps valid unique ids and appends omitted cards', () => {
    assert.deepEqual(
      normalizeCompanyOverviewCardOrder(['hr', 'sales', 'hr', 'bogus']),
      ['hr', 'sales', 'finance', 'inventory', 'procurement', 'warehouse', 'liquidity', 'budget']
    );
    assert.deepEqual(normalizeCompanyOverviewCardOrder(null), [
      'finance',
      'inventory',
      'procurement',
      'warehouse',
      'liquidity',
      'budget',
      'sales',
      'hr',
    ]);
  });

  test('the stored map rejects malformed roles and entries', () => {
    const raw = JSON.stringify({
      FRONT_DESK: ['sales', 'finance'],
      branch_manager: ['hr'],
      ACCOUNTANT: 'not-an-array',
      _BAD: ['hr'],
      AUDITOR: ['hr', 'not-a-card'],
    });
    assert.deepEqual(parseCompanyOverviewCardOrders(raw), {
      FRONT_DESK: ['sales', 'finance', 'inventory', 'procurement', 'warehouse', 'liquidity', 'budget', 'hr'],
      AUDITOR: ['hr', 'finance', 'inventory', 'procurement', 'warehouse', 'liquidity', 'budget', 'sales'],
    });
  });

  test('lookup is role-scoped and falls back to the default order', () => {
    const raw = JSON.stringify({
      FRONT_DESK: [
        'sales',
        'hr',
        'finance',
        'inventory',
        'procurement',
        'warehouse',
        'liquidity',
        'budget',
      ],
    });
    assert.deepEqual(companyOverviewCardOrderForRole(raw, 'FRONT_DESK'), [
      'sales',
      'hr',
      'finance',
      'inventory',
      'procurement',
      'warehouse',
      'liquidity',
      'budget',
    ]);
    assert.deepEqual(companyOverviewCardOrderForRole(raw, 'ACCOUNTANT'), [
      'finance',
      'inventory',
      'procurement',
      'warehouse',
      'liquidity',
      'budget',
      'sales',
      'hr',
    ]);
    assert.deepEqual(companyOverviewCardOrderForRole('not json', 'FRONT_DESK'), [
      'finance',
      'inventory',
      'procurement',
      'warehouse',
      'liquidity',
      'budget',
      'sales',
      'hr',
    ]);
  });
});
