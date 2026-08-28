import { describe, it, expect } from 'vitest';
import {
  loginBodySchema,
  productCreateSchema,
  poCreateSchema,
  shipmentCreateSchema,
  passwordSchema,
  approvalProcessSchema,
} from '../../server/lib/validate';

describe('zod validation schemas', () => {
  it('accepts valid login bodies and rejects bad emails', () => {
    expect(loginBodySchema.parse({ email: 'a@b.co', password: 'x' }).email).toBe('a@b.co');
    expect(() => loginBodySchema.parse({ email: 'nope', password: 'x' })).toThrow();
    expect(() => loginBodySchema.parse({ email: 'a@b.co', password: '' })).toThrow();
  });

  it('validates product create payloads', () => {
    const p = productCreateSchema.parse({
      name: 'ONU X',
      sku: 'SKU-1',
      costPrice: '10',
      sellingPrice: 12,
    });
    expect(p.costPrice).toBe(10);
    expect(p.taxRate).toBe(13);
    expect(p.status).toBe('ACTIVE');
    expect(() => productCreateSchema.parse({ name: '', sku: 'S' })).toThrow();
  });

  it('requires PO line items with positive qty', () => {
    const po = poCreateSchema.parse({
      supplierName: 'Vendor',
      branchId: 'WH001',
      items: [{ productId: 'p1', quantity: 2, unitPrice: 100 }],
    });
    expect(po.items).toHaveLength(1);
    expect(() =>
      poCreateSchema.parse({ supplierName: 'V', branchId: 'WH001', items: [] })
    ).toThrow();
    expect(() =>
      poCreateSchema.parse({
        supplierName: 'V',
        branchId: 'WH001',
        items: [{ productId: 'p1', quantity: 0, unitPrice: 1 }],
      })
    ).toThrow();
  });

  it('validates shipment items', () => {
    const s = shipmentCreateSchema.parse({
      destinationBranchId: 'ITH01',
      items: [{ productId: 'p1', quantitySent: 3 }],
    });
    expect(s.type).toBe('INTER_BRANCH');
    expect(() =>
      shipmentCreateSchema.parse({ destinationBranchId: 'X', items: [] })
    ).toThrow();
  });

  it('enforces strict password policy when enabled', () => {
    const prev = process.env.STRICT_PASSWORD_POLICY;
    process.env.STRICT_PASSWORD_POLICY = 'true';
    try {
      expect(() => passwordSchema().parse('alllowercase1!')).toThrow();
      expect(passwordSchema().parse('GoodPass1!')).toBe('GoodPass1!');
    } finally {
      if (prev === undefined) delete process.env.STRICT_PASSWORD_POLICY;
      else process.env.STRICT_PASSWORD_POLICY = prev;
    }
  });

  it('validates approval process status', () => {
    expect(approvalProcessSchema.parse({ status: 'APPROVED' }).status).toBe('APPROVED');
    expect(() => approvalProcessSchema.parse({ status: 'MAYBE' })).toThrow();
  });
});
