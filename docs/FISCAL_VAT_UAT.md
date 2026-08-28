# Fiscal / VAT / IRD — Accountant UAT Checklist

Use this script with a Super Admin + Accountant role on a staging database
seeded with real-ish Nepal ISP data (BS dates, 13% VAT).

## Preconditions
- [ ] `database.mode = postgres` on `/api/health`
- [ ] Current fiscal year set (e.g. 2082/83) under Nepali Fiscal Management
- [ ] Company PAN/VAT number configured
- [ ] At least 2 branches, 5 products (mix taxable / exempt), 1 supplier with PAN

## A. Purchase VAT register
1. Create PO → Approve → Receive goods.
2. Create Purchase Invoice with:
   - Taxable lines @ 13% VAT
   - At least one tax-exempt line
3. Record partial then full payment.
4. Open **VAT Register**:
   - [ ] Invoice appears with correct taxable amount, VAT, non-taxable
   - [ ] Grand total = taxable + VAT + non-taxable − discounts
   - [ ] BS invoice date displays correctly in BS mode
5. Export VAT register CSV/XLSX:
   - [ ] Columns match IRD-friendly layout (bill no, supplier PAN, taxable, VAT 13%, total)

## B. Stock valuation & COGS
1. Issue consumables / stock-out with known unit costs.
2. Open **Stock Valuation**:
   - [ ] On-hand × cost price matches branch filters
3. Open **Financial Statements** summary:
   - [ ] `totalCostOfGoodsSold` moves with stock-out / consumable issue (not hardcoded)
   - [ ] Inventory asset value drops after stock-out

## C. Fixed assets & depreciation
1. Register a fixed asset (acquisition AD + BS, method SLM / declining / WDV).
2. Open **Depreciation Register**:
   - [ ] Annual charge matches method × rate
   - [ ] NBV = cost − accumulated
3. Assign asset to location/customer; status updates.

## D. Fiscal year close wizard
1. Start **Fiscal Year Closing Wizard** on a non-current prior year copy in staging.
2. Walk all steps:
   - [ ] Inventory valuation snapshot
   - [ ] Depreciation posting preview
   - [ ] Trial balance roll-forward counts
   - [ ] Super Admin authorization key required
3. Complete close:
   - [ ] Year marked `isClosed`
   - [ ] Cannot post stock mutations into closed year (if enforced)
4. Download IRD closing certificate (if enabled):
   - [ ] Company name, PAN, FY code, timestamp present

## E. BS calendar integrity
1. Toggle header date mode BS ↔ AD.
2. Create PO / shipment / stock op:
   - [ ] `dateBS` is live (not a fixed `2083-04-16`)
3. Fiscal management calendar seed:
   - [ ] Days for current BS year load without gaps

## F. Branch / role matrix (Accountant)
| Action | Accountant expected |
|---|---|
| View VAT register | Allowed |
| Pay purchase invoice | Allowed |
| Create stock-out | Denied |
| Close fiscal year | Allowed (with SA key if required) |
| Edit products | Denied |

## Sign-off
| Role | Name | Date | Pass? | Notes |
|---|---|---|---|---|
| Accountant | | | | |
| Super Admin | | | | |
| Auditor | | | | |

## Automated smoke (dev)
```bash
npm test -- tests/unit/stockInvariants.test.ts tests/api/procurement.api.test.ts
curl -s localhost:3000/api/health | jq '.database'
```
