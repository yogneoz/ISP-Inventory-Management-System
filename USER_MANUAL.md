# Enterprise ERP & Inventory Management System — Comprehensive User Manual

Welcome to the **Enterprise ERP & Inventory Management System** user guide. This document provides step-by-step operating instructions for all team members, store managers, accountants, auditors, and administrators.

---

## 📖 Table of Contents
1. [System Overview & Core Capabilities](#1-system-overview--core-capabilities)
2. [User Roles & Permission Matrix](#2-user-roles--permission-matrix)
3. [Getting Started & Account Management](#3-getting-started--account-management)
   - [Logging In & Switching Profiles](#logging-in--switching-profiles)
   - [Branch Switching](#branch-switching)
   - [Dual Calendar System (BS & AD)](#dual-calendar-system-bs--ad)
4. [Module Operating Guides](#4-module-operating-guides)
   - [4.1 Dashboard & Quick Metrics](#41-dashboard--quick-metrics)
   - [4.2 Product & Barcode Catalog](#42-product--barcode-catalog)
   - [4.3 Inventory & Stock Operations](#43-inventory--stock-operations)
   - [4.4 Physical Stock Audit & Reconciliation](#44-physical-stock-audit--reconciliation)
   - [4.5 ISP & Device Serial Management](#45-isp--device-serial-management)
   - [4.6 Multi-Tier Approval Workflow Center](#46-multi-tier-approval-workflow-center)
   - [4.7 Purchase Orders, Invoices & Shipments](#47-purchase-orders-invoices--shipments)
   - [4.8 Financial Statements & VAT Register](#48-financial-statements--vat-register)
   - [4.9 Fixed Asset Register & Depreciation](#49-fixed-asset-register--depreciation)
   - [4.10 Nepali Fiscal Calendar & Year Closing Wizard](#410-nepali-fiscal-calendar--year-closing-wizard)
   - [4.11 User & Permission Management](#411-user--permission-management)
   - [4.12 Audit Trail & System Logs](#412-audit-trail--system-logs)
5. [Barcode Scanner Tools](#5-barcode-scanner-tools)
6. [Frequently Asked Questions & Troubleshooting](#6-frequently-asked-questions--troubleshooting)

---

## 1. System Overview & Core Capabilities

The Enterprise ERP system is built for multi-branch retail, wholesale, and ISP operations. Key highlights include:

- **Multi-Branch & Location Architecture**: Isolated inventory views per branch or consolidated HQ oversight.
- **Dual Nepali Fiscal Calendar (BS & AD)**: Native support for Bikram Sambat (2080, 2081 BS) and Gregorian dates.
- **Device Serial & ONU Tracking**: Track individual hardware serial numbers from intake through customer installation and returns.
- **5-Tier Governance & Approvals**: Financial refunds, stock write-offs, and device replacements require mandatory manager approval.
- **Fiscal Year Closing Lock**: 5-step closing wizard that freezes ledgers and rolls balances forward into the new fiscal period.

---

## 2. User Roles & Permission Matrix

The system enforces strict Role-Based Access Control (RBAC):

| Role | Access Scope | Key Responsibilities |
| :--- | :--- | :--- |
| `SUPER_ADMIN` | Full System Access | System setup, user management, branch creation, fiscal year closing, global overrides. |
| `BRANCH_MANAGER` | Branch Scope | Stock transfers, purchase approvals, stock count reconciliations, branch reports. |
| `STORE_INCHARGE` | Warehouse / Store Scope | Inward/Outward stock logging, barcode scanning, physical stock audits. |
| `ACCOUNTANT` | Financial & Tax Scope | VAT register, purchase invoices, fixed asset depreciation, financial statements. |
| `AUDITOR` | Read-Only Audit Scope | Audit trails, transaction verification, physical inventory count inspection. |
| `ISP_FIELD_TECH` | Field & Device Scope | ONU/Router serial assignment, customer installations, field return requests. |

---

## 3. Getting Started & Account Management

### Logging In & Switching Profiles
1. Access the application URL in your web browser.
2. Enter your registered email address and password.
3. **Quick Switcher (Top Right Header)**:
   - Click your profile avatar on the top right header to expand the quick profile switcher.
   - Select any team member profile to switch context instantly (if permitted).
   - Click **"Switch Back"** at any time to return to your primary account.

### Branch Switching
- Located on the left side of the top header.
- Select **"All Branches (HQ Consolidated)"** for global executive reports or pick a specific branch (e.g., *Kathmandu HQ*, *Pokhara Branch*) to filter data.

### Dual Calendar System (BS & AD)
- The header continuously displays today's date in both **AD** (Gregorian) and **BS** (Nepali Bikram Sambat, e.g., *2081 Shrawan 26*).
- System transactions automatically record both timestamps for official VAT and tax reporting.

---

## 4. Module Operating Guides

### 4.1 Dashboard & Quick Metrics
- **Real-Time KPIs**: Total Stock Valuation, Low Stock Alerts, Damaged Goods Count, Pending Approvals, Active ONU Serial Allocations.
- **Quick Action Bar**: One-click access to *Scan Barcode*, *New Purchase Order*, *Stock Audit*, and *Transfer Request*.
- **Visual Analytics**: Interactive stock movement charts and top categories distribution.

---

### 4.2 Product & Barcode Catalog
**Navigation**: `Master Data -> Product Catalog`

1. **Add New Product**:
   - Click `+ Add Product`.
   - Fill in SKU, Name, Category, Unit of Measurement (UOM), Cost Price, Selling Price, and Reorder Point.
   - Enter or auto-generate a unique Barcode string.
2. **Barcodes & Printing**:
   - Click the **Barcode Icon** next to any item to view its generated Barcode label ready for thermal printing.

---

### 4.3 Inventory & Stock Operations
**Navigation**: `Inventory -> Stock Movements / Operations`

1. **Logging Stock Movements**:
   - Choose operation type: **Inward Stock (Purchase/Receiving)**, **Outward Stock (Sale/Dispatch)**, **Branch Transfer**, or **Adjustment**.
   - Select Product, Quantity, Source Location, Destination Location, and Batch/Serial number.
   - System automatically validates available quantity before executing.

2. **Damaged Stock Tracking**:
   - Navigate to `Inventory -> Damaged Stock`.
   - Log damaged goods with photos/notes and flag for repair, disposal, or manager write-off approval.

---

### 4.4 Physical Stock Audit & Reconciliation
**Navigation**: `Inventory -> Physical Stock Audit`

1. **Create Audit Batch**: Select target Branch and Category.
2. **Perform Physical Count**:
   - Use a physical barcode scanner or enter counted quantities manually against system records.
3. **Variance Inspection**:
   - System highlights discrepancies (Surplus/Deficit) in real time.
4. **Execute Reconciliation**:
   - Submit for manager approval. Once approved, inventory stock levels automatically adjust to physical counts with an audit entry.

---

### 4.5 ISP & Device Serial Management
**Navigation**: `ISP & Hardware -> Customer Device Register`

Designed specifically for Internet Service Providers (ISPs) and IT distributors:
1. **Serial Number Intake**:
   - Scan or import MAC address / Serial Number for hardware devices (e.g., Fiber ONUs, Routers, Switches).
2. **Customer Assignment**:
   - Assign hardware serial numbers directly to customer account IDs.
   - System updates device status: `In Warehouse` ➔ `Assigned to Customer` ➔ `Installed & Active`.
3. **Device Returns & Exchanges**:
   - Log defective or returned devices. Initiates an automated replacement request in the Approval Workflow Center.

---

### 4.6 Multi-Tier Approval Workflow Center
**Navigation**: `Governance -> Approval Center`

Requests requiring authorization (Device Returns, Stock Write-offs, High-Value Purchase Orders):
1. **Pending Queue**: Displays all requests submitted by field techs, storekeepers, or accountants.
2. **Review & Action**:
   - Click **Approve** or **Reject** with mandatory reviewer comments.
   - Approved device returns automatically update customer status and return hardware back into store inventory.

---

### 4.7 Purchase Orders, Invoices & Shipments
**Navigation**: `Purchasing -> Purchase Orders / Purchase Invoices / Shipments`

1. **Creating Purchase Orders (PO)**:
   - Select Supplier, Expected Delivery Date, and Line Items.
   - Submit PO for manager approval.
2. **Generating Purchase Invoices**:
   - Convert approved POs into Purchase Invoices.
   - Enter Supplier Invoice # and Pan/VAT Number.
3. **Shipments & Tracking**:
   - Track inbound supplier shipments, carrier tracking codes, and arrival status across branches.

---

### 4.8 Financial Statements & VAT Register
**Navigation**: `Finance & Tax -> VAT Register / Financial Statements`

1. **VAT Register**:
   - Automated Sales VAT Register and Purchase VAT Register compliant with Inland Revenue Department guidelines.
   - Filter by Nepali Month / Fiscal Year (e.g., *2080/81 Shrawan*).
2. **Financial Statements**:
   - Generate **Trial Balance**, **Profit & Loss Statement (P&L)**, and **Balance Sheet** with 1-click CSV/PDF export.

---

### 4.9 Fixed Asset Register & Depreciation
**Navigation**: `Finance & Tax -> Fixed Asset Register`

1. **Asset Entry**: Record company assets (Computers, Vehicles, Machinery, Buildings) with purchase price and date.
2. **Depreciation Methods**:
   - **Straight Line Method (SLM)**
   - **Written Down Value (WDV)**
3. **Automated Calculations**: Calculates monthly and annual depreciation expense and net book value automatically.

---

### 4.10 Nepali Fiscal Calendar & Year Closing Wizard
**Navigation**: `Finance & Tax -> Fiscal Year Closing`

1. **Fiscal Year Settings**: Manage active fiscal periods (e.g., `2080/81`, `2081/82`).
2. **5-Step Closing Wizard**:
   - **Step 1**: Pre-Closing Reconciliation Check.
   - **Step 2**: Unposted Transactions Audit.
   - **Step 3**: Physical Stock Finalization.
   - **Step 4**: Retained Earnings & Balance Carry-Forward.
   - **Step 5**: Fiscal Period Freeze & Lock.
   *(Note: Once locked, prior year ledger entries cannot be modified without Super Admin unlocking).*

---

### 4.11 User & Permission Management
**Navigation**: `System Admin -> User Accounts / Permissions`

1. **Create User Account**: Set Name, Email, Password, Role, and Assigned Branch.
2. **Granular Permissions**:
   - Toggle specific action permissions (e.g., `can_export_reports`, `can_approve_transfers`, `can_edit_prices`).

---

### 4.12 Audit Trail & System Logs
**Navigation**: `System Admin -> Audit Trail`

- Immutably records every system event: User ID, Action, Module, Timestamp (AD & BS), IP Address, and Changes (Before/After JSON values).
- Searchable by user, date range, or module keyword.

---

## 5. Barcode Scanner Tools

### 📷 Barcode Scanner Modal
- Click **"Scan Barcode"** in the top header.
- Use your device camera or plug in a USB handheld barcode scanner.
- Instant item lookup, stock quantity inspection, and quick movement logging.

---

## 6. Frequently Asked Questions & Troubleshooting

#### Q1: "Permission Denied" error when attempting stock transfer?
**A**: Ensure your user profile is assigned `BRANCH_MANAGER` or `SUPER_ADMIN` role, or contact your administrator to grant `can_approve_transfers` permission in User Management.

#### Q2: How do I unlock a closed Fiscal Year?
**A**: Only a `SUPER_ADMIN` user can reopen a locked fiscal year from `Finance & Tax -> Fiscal Year Settings -> Unlock Year`.

#### Q3: Can I import stock items from Excel / CSV?
**A**: Yes! Go to `Master Data -> Product Catalog -> Import CSV`. Download the sample CSV template, populate your SKUs, and upload.

---

*Enterprise ERP User Manual v2.5 — Generated for Operations & Admin Team*
