/**
 * Zod request validation helpers for write routes.
 */
import { z, type ZodSchema, type ZodTypeAny } from 'zod';
import type { Request, Response, NextFunction } from 'express';

export const emailSchema = z.string().trim().email().max(150);
export const nonEmpty = z.string().trim().min(1);
export const optionalString = z.string().trim().optional().nullable();

/** Stronger production password policy (still accepts 8+ for backward compat via env). */
export function passwordSchema() {
  const min = Number(process.env.MIN_PASSWORD_LENGTH || 8);
  let s = z.string().min(min, `Password must be at least ${min} characters`);
  if (process.env.STRICT_PASSWORD_POLICY === 'true') {
    s = s
      .regex(/[A-Z]/, 'Password must include an uppercase letter')
      .regex(/[a-z]/, 'Password must include a lowercase letter')
      .regex(/[0-9]/, 'Password must include a number')
      .regex(/[^A-Za-z0-9]/, 'Password must include a special character');
  }
  return s;
}

export const loginBodySchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required'),
});

export const setupSuperAdminSchema = z.object({
  name: nonEmpty.max(150),
  email: emailSchema,
  password: passwordSchema(),
  branchId: z.string().trim().optional(),
});

export const productCreateSchema = z.object({
  name: nonEmpty.max(255),
  sku: nonEmpty.max(100),
  barcode: z.string().trim().max(100).optional().default(''),
  category: z.string().trim().max(100).optional().default('General'),
  productGroup: z
    .enum(['Product Item', 'Fixed Asset', 'Consumable Item'])
    .optional()
    .default('Product Item'),
  unit: z.string().trim().max(30).optional().default('Pcs'),
  costPrice: z.coerce.number().min(0).optional().default(0),
  sellingPrice: z.coerce.number().min(0).optional().default(0),
  taxRate: z.coerce.number().min(0).max(100).optional().default(13),
  minReorderLevel: z.coerce.number().int().min(0).optional().default(5),
  requiresSerialTracking: z.boolean().optional().default(false),
  trackingType: z.enum(['SERIAL_MAC_PON', 'QUANTITY_ONLY']).optional().default('QUANTITY_ONLY'),
  description: z.string().optional().default(''),
  status: z.enum(['ACTIVE', 'INACTIVE', 'DISCONTINUED']).optional().default('ACTIVE'),
});

export const productUpdateSchema = productCreateSchema.partial();

export const stockPatchSchema = z.object({
  quantityOnHand: z.coerce.number().optional(),
  damagedQty: z.coerce.number().min(0).optional(),
  minReorderLevel: z.coerce.number().int().min(0).optional(),
  reason: z.string().trim().max(500).optional(),
  changeType: z.string().trim().max(50).optional(),
});

export const poCreateSchema = z.object({
  supplierName: nonEmpty.max(200),
  branchId: nonEmpty.max(50),
  status: z
    .enum(['DRAFT', 'APPROVED', 'SENT', 'IN_PROGRESS', 'PURCHASED', 'RECEIVED', 'CANCELLED'])
    .optional()
    .default('DRAFT'),
  notes: z.string().optional(),
  orderDateAD: z.string().optional(),
  orderDateBS: z.string().optional(),
  expectedDeliveryDateAD: z.string().optional(),
  items: z
    .array(
      z.object({
        id: z.string().optional(),
        productId: nonEmpty,
        productName: z.string().optional(),
        sku: z.string().optional(),
        quantity: z.coerce.number().positive(),
        unitPrice: z.coerce.number().min(0),
        taxRate: z.coerce.number().min(0).max(100).optional().default(13),
        subtotal: z.coerce.number().optional(),
        taxAmount: z.coerce.number().optional(),
        total: z.coerce.number().optional(),
        discount: z.coerce.number().optional(),
        isTaxExempt: z.boolean().optional(),
        unit: z.string().optional(),
      })
    )
    .min(1, 'At least one line item is required'),
});

export const shipmentCreateSchema = z.object({
  type: z.enum(['INTER_BRANCH', 'SUPPLIER_INBOUND']).optional().default('INTER_BRANCH'),
  sourceBranchId: z.string().optional(),
  destinationBranchId: nonEmpty,
  sourceBranchName: z.string().optional(),
  destinationBranchName: z.string().optional(),
  status: z.string().optional(),
  notes: z.string().optional(),
  dispatchDateAD: z.string().optional(),
  dispatchDateBS: z.string().optional(),
  estimatedArrivalAD: z.string().optional(),
  items: z
    .array(
      z.object({
        id: z.string().optional(),
        productId: nonEmpty,
        productName: z.string().optional(),
        sku: z.string().optional(),
        quantitySent: z.coerce.number().positive().optional(),
        quantity: z.coerce.number().positive().optional(),
      })
    )
    .min(1),
});

export const approvalCreateSchema = z.object({
  type: nonEmpty,
  targetId: nonEmpty,
  customerName: z.string().optional().default(''),
  customerCode: z.string().optional(),
  deviceSerial: z.string().optional().default(''),
  ponSerial: z.string().optional(),
  productName: z.string().optional().default(''),
  currentStatus: z.string().optional().default(''),
  requestedStatus: nonEmpty,
  requestedByRole: z.string().optional(),
  requestedByEmail: z.string().optional(),
  requestedByName: z.string().optional(),
  branchId: nonEmpty,
  branchName: z.string().optional(),
  reason: nonEmpty.max(2000),
  restockQtyOnApproval: z.boolean().optional(),
});

export const approvalProcessSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
  rejectionReason: z.string().trim().max(2000).optional(),
  approverUser: z.any().optional(),
});

export function validateBody<T extends ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Validation failed',
        code: 'VALIDATION_ERROR',
        errors: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    req.body = parsed.data;
    next();
  };
}

export function parseOrThrow<T>(schema: ZodSchema<T>, data: unknown): T {
  return schema.parse(data);
}

export { z };
