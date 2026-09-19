-- Test customer sales for validating the Trading / Gross Surplus statement.
-- Mirrors the exact items JSON structure the Product Sale form posts.

-- Sale 1: 3x fast connector + 2x coupler to CUS-10291 on 2026-09-10
INSERT INTO stock_operations (id, reference_number, type, branch_id, branch_name, total_value, reason, date_ad, date_bs, fiscal_year, status, items)
VALUES ('op-sale-0001', 'BRH01-SALE-20260910-0001', 'STOCK_OUT', 'BRH01', 'Branch 2', 292.00,
  'Customer Product Sale Invoice (2 items): Ashish Gurung (CUS-10291) - Direct retail product item sale to customer',
  '2026-09-10', '2083-05-25 BS', '2083-84', 'LOGGED',
  '[{"id":"sli-1","productId":"prod-fcn001","productName":"Fast Connector SC/UPC Fiber Optical","sku":"FCN001","quantity":3,"sellingPrice":56,"discount":0,"totalValue":168},{"id":"sli-2","productId":"prod-cpl001","productName":"Fiber Optic Coupler SC/APC Simplex Adapter","sku":"CPL001","quantity":2,"sellingPrice":62,"discount":0,"totalValue":124}]');

-- Sale 2: 1x splitter to CUS-10292 on 2026-09-12 with a discount
INSERT INTO stock_operations (id, reference_number, type, branch_id, branch_name, total_value, reason, date_ad, date_bs, fiscal_year, status, items)
VALUES ('op-sale-0002', 'WH001-SALE-20260912-0002', 'STOCK_OUT', 'WH001', 'Branch 1 (Head Office)', 513.00,
  'Customer Product Sale Invoice (1 items): Sita Sharma (CUS-10292) - Direct retail product item sale to customer',
  '2026-09-12', '2083-05-27 BS', '2083-84', 'LOGGED',
  '[{"id":"sli-3","productId":"prod-spl001","productName":"PLC Fiber Optic Splitter 1x8 SC/APC","sku":"SPL001","quantity":1,"sellingPrice":563,"discount":50,"totalValue":513}]');