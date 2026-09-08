// ============================================================================
// Shared demo/dummy dataset definitions.
//
// This module is the SINGLE SOURCE for the sample data seeded by
// `npm run setup:pg` (scripts/setup_db.js). The Express server never seeds
// dummy data at runtime - it only reads and writes what is in PostgreSQL.
//
// Every record produced here carries `isDemo: true` so it is inserted with
// is_demo = TRUE in the database. The admin "Clear Demo Data" action only
// removes rows where is_demo = TRUE, leaving real business data untouched.
// ============================================================================

const EXCEL_ITEMS = [
  { code: 'SPL001', group: 'CONSUMABLE ITEM', type: 'Splitter', name: 'PLC Fiber Optic Splitter 1x8 SC/APC', uom: 'Pcs', qty: 50, val: 450 },
  { code: 'SPL002', group: 'CONSUMABLE ITEM', type: 'Splitter', name: 'PLC Fiber Optic Splitter 1x16 SC/APC', uom: 'Pcs', qty: 30, val: 850 },
  { code: 'SLV001', group: 'CONSUMABLE ITEM', type: 'Sleeves', name: 'Fiber Fusion Protection Sleeve 60mm (Pack of 100)', uom: 'Box', qty: 100, val: 250 },
  { code: 'CPL001', group: 'CONSUMABLE ITEM', type: 'Coupler', name: 'Fiber Optic Coupler SC/APC Simplex Adapter', uom: 'Pcs', qty: 200, val: 35 },
  { code: 'FCN001', group: 'CONSUMABLE ITEM', type: 'Fast Connector', name: 'Fast Connector SC/UPC Fiber Optical', uom: 'Pcs', qty: 150, val: 45 },
  { code: 'PTC001', group: 'CONSUMABLE ITEM', type: 'Patch Cord', name: 'Fiber Patch Cord SC/APC-SC/APC 3M Simplex', uom: 'Pcs', qty: 80, val: 180 },
  { code: 'ADP001', group: 'CONSUMABLE ITEM', type: 'Adaptor', name: '0 DB ADAPTAR SC/APC', uom: 'Pcs', qty: 100, val: 25 },
  { code: 'DRP002', group: 'CONSUMABLE ITEM', type: 'Drop Cable', name: 'DROP CABLE 100 MTR ROLL', uom: 'Roll', qty: 20, val: 2500 },
  { code: 'FIB003', group: 'CONSUMABLE ITEM', type: 'Fiber', name: '4 CORE OPTICAL FIBER CABLE', uom: 'Mtr', qty: 500, val: 45 },
  { code: 'CAR004', group: 'FIXED ASSET', type: 'Olt Card', name: 'OLT CARD GPON 16-PORT Chassis Module', uom: 'Pcs', qty: 2, val: 125000 },
  { code: 'ONU001', group: 'PRODUCT ITEM', type: 'Onu Router', name: 'ONU ROUTER DUAL BAND 2.4G/5G GPON', uom: 'Pcs', qty: 25, val: 3200 },
  { code: 'ONU002', group: 'PRODUCT ITEM', type: 'Onu Router', name: 'ONU ROUTER SINGLE BAND 2.4G XPON', uom: 'Pcs', qty: 40, val: 1850 },
];

const NON_SERIALIZED_CATEGORIES = [
  'Drop Cable', 'Cat6 Cable', 'Fiber', 'Dac Cable', 'Patch Cord',
  'Fast Connector', 'Coupler', 'Splitter', 'Distribution Box',
  'Av Jack', 'Binding Wire', 'Adaptor', 'Sleeves', 'Tiffin Bod', 'Cassettte',
];

// Demo suppliers use their own id namespace (demo-sup-*) so they can never
// collide with real supplier master records.
const DEMO_SUPPLIERS = [
  {
    id: 'demo-sup-1',
    name: 'Example Supplier 1',
    contactPerson: 'Example Contact 1',
    phone: '+977-01-0000011',
    email: 'demo.supplier1@example.com',
    address: 'Example Street, Example City, Nepal',
    panVatNumber: '100000011',
    rating: 4.8,
  },
  {
    id: 'demo-sup-2',
    name: 'Example Supplier 2',
    contactPerson: 'Example Contact 2',
    phone: '+977-01-0000012',
    email: 'demo.supplier2@example.com',
    address: 'Example Avenue, Example City, Nepal',
    panVatNumber: '200000012',
    rating: 4.6,
  },
  {
    id: 'demo-sup-3',
    name: 'Example Supplier 3',
    contactPerson: 'Example Contact 3',
    phone: '+977-01-0000013',
    email: 'demo.supplier3@example.com',
    address: 'Example Road, Example City, Nepal',
    panVatNumber: '300000013',
    rating: 4.9,
  },
];

/**
 * Builds the complete demo dataset (all records marked isDemo: true).
 *
 * @param {Array<{id: string, code: string, isHeadquarters: boolean}>} branches
 *   The branch master list used to spread demo stock across the network.
 */
export function buildDemoDataset(branches) {
  const demoSuppliers = DEMO_SUPPLIERS.map((s) => ({ ...s, isDemo: true }));

  const demoProducts = EXCEL_ITEMS.map((item, idx) => {
    const isConsumableOrCable =
      item.group === 'CONSUMABLE ITEM' ||
      NON_SERIALIZED_CATEGORIES.includes(item.type) ||
      ['Mtr', 'Roll', 'Box'].includes(item.uom) ||
      item.name.includes('CABLE') ||
      item.name.includes('WIRE') ||
      item.name.includes('CONNECTOR') ||
      item.name.includes('SPLITTER') ||
      item.name.includes('SLEEVE') ||
      item.name.includes('COUPLER') ||
      item.name.includes('ADAPTAR');

    const requiresSerialTracking = !isConsumableOrCable && item.group !== 'CONSUMABLE ITEM';

    let productGroup = 'Product Item';
    if (item.group === 'FIXED ASSET') {
      productGroup = 'Fixed Asset';
    } else if (isConsumableOrCable) {
      productGroup = 'Consumable Item';
    }

    const product = {
      id: `prod-${item.code.toLowerCase()}`,
      sku: item.code,
      barcode: `890${String(100000000 + idx).slice(1)}`,
      name: item.name,
      category: item.type,
      productGroup,
      unit: item.uom,
      costPrice: item.val > 0 ? item.val : 1500,
      sellingPrice: item.val > 0 ? Math.round(item.val * 1.25) : 1875,
      taxRate: 13,
      minReorderLevel: productGroup === 'Consumable Item' ? 20 : (productGroup === 'Fixed Asset' ? 0 : 5),
      requiresSerialTracking,
      trackingType: requiresSerialTracking ? 'SERIAL_MAC_PON' : 'QUANTITY_ONLY',
      description: `[${productGroup}] ${item.type} - ${item.name}`,
      isDemo: true,
    };

    if (productGroup === 'Fixed Asset') {
      product.depreciationMethod = 'STRAIGHT_LINE';
      product.depreciationRate = 15;
      product.usefulLifeYears = 5;
      product.salvageValuePercent = 10;
    }

    return product;
  });

  // Demo stock: every product in every branch (consumables in larger volumes).
  const demoInventoryStock = [];
  const demoDamageRecords = [];
  let seededDamagedCount = 0;

  demoProducts.forEach((p, index) => {
    branches.forEach((branch, bIdx) => {
      const isConsumable = p.productGroup === 'Consumable Item';
      const baseQty = isConsumable
        ? (branch.isHeadquarters ? 150 + ((index * 10) % 100) : 35 + ((index + bIdx) % 25))
        : 2 + ((index + bIdx) % 2);
      const qty = baseQty;

      let damagedQty = 0;
      if (seededDamagedCount < 21 && (index * 7 + bIdx * 3 + 1) % 13 === 0) {
        damagedQty = 1;
        seededDamagedCount += 1;

        // Create a proper damage record for this damaged item
        const damageReasons = ['PHYSICAL_DAMAGE', 'TRANSIT_DAMAGE', 'STORAGE_DAMAGE', 'QUALITY_DEFECT'];
        const damageReason = damageReasons[(index + bIdx) % damageReasons.length];
        const damageDateAD = '2026-08-15';
        const damageDateBS = '2083-04-31 BS';

        demoDamageRecords.push({
          id: `dmr-${p.id.toLowerCase()}-${branch.id.toLowerCase()}`,
          damageReference: `DMR-${p.sku}-${branch.id}-001`,
          productId: p.id,
          branchId: branch.id,
          quantityDamaged: damagedQty,
          unitCost: p.costPrice,
          totalCost: damagedQty * p.costPrice,
          damageDateAD,
          damageDateBS,
          damageReason,
          status: 'IDENTIFIED',
          disposalDateAD: null,
          disposalDateBS: null,
          disposalMethod: null,
          salvageValue: 0,
          glAccountCode: 'GL-5120 (Loss on Inventory Scrap & Write-off)',
          writeOffLoss: 0,
          approvedBy: 'System (Demo)',
          notes: `Demo damage record for ${p.name} at ${branch.name}`,
          fiscalYearId: 'fy-4',
          isDemo: true,
          createdBy: 'System Seeder',
        });
      }

      const branchMinReorder = branch.isHeadquarters
        ? p.minReorderLevel * 2
        : (bIdx % 3 === 0 ? p.minReorderLevel : Math.max(1, Math.floor(p.minReorderLevel / 2)));

      demoInventoryStock.push({
        id: `stk-${branch.id.toLowerCase()}-${p.id}`,
        productId: p.id,
        branchId: branch.id,
        quantityOnHand: qty,
        damagedQty,
        reservedQty: 0,
        incomingQty: 0,
        minReorderLevel: branchMinReorder,
        isDemo: true,
      });
    });
  });

  // Demo fixed assets: one per FIXED ASSET excel item.
  const demoAssetRegister = EXCEL_ITEMS
    .filter((item) => item.group === 'FIXED ASSET')
    .map((item, idx) => {
      let cat = 'IT Equipment';
      if (item.type === 'Furniture') cat = 'Furniture';
      else if (item.type === 'Air Conditioner' || item.type === 'Tiffin Bod') cat = 'Fixtures';
      else if (item.type === 'Fiber Fusion Splicer' || item.type === 'Cutter' || item.type === 'Ladder') cat = 'Machinery';

      const cost = item.val > 0 ? item.val * 1000 : 25000;
      const accum = Math.round(cost * 0.15);
      const assignedBranch = branches[idx % branches.length].id;

      return {
        id: `ast-${item.code.toLowerCase()}`,
        tagNumber: `AST-${item.code}`,
        name: item.name,
        category: cat,
        branchId: assignedBranch,
        acquisitionDateAD: '2024-04-15',
        acquisitionDateBS: '2081-01-03 BS',
        purchaseInvoiceDateAD: '2024-04-15',
        purchaseInvoiceDateBS: '2081-01-03 BS',
        capitalizationDateAD: '2024-04-15',
        placedInServiceDateAD: '2024-04-15',
        acquisitionCost: cost,
        depreciationMethod: 'STRAIGHT_LINE',
        depreciationRatePercent: 15,
        accumulatedDepreciation: accum,
        netBookValue: cost - accum,
        productId: `prod-${item.code.toLowerCase()}`,
        status: 'ACTIVE',
        isDemo: true,
      };
    });

  // Demo purchase order (references the first demo supplier + a demo product).
  const demoPurchaseOrders = [
    {
      id: 'demo-po-101',
      poNumber: 'PO-DEMO-001',
      supplierName: demoSuppliers[0].name,
      branchId: branches.length > 0 ? branches[0].id : 'WH001',
      orderDateAD: '2026-07-20',
      orderDateBS: '2083-04-05 BS',
      expectedDeliveryDateAD: '2026-08-05',
      status: 'SENT',
      items: [
        {
          id: 'demo-poi-1',
          productId: 'prod-onu001',
          productName: 'ONU ROUTER DUAL BAND 2.4G/5G GPON',
          sku: 'ONU001',
          quantity: 50,
          unitPrice: 2500,
          taxRate: 13,
          subtotal: 125000,
          taxAmount: 16250,
          total: 141250,
        },
      ],
      subtotalAmount: 125000,
      taxAmount: 16250,
      totalAmount: 141250,
      notes: 'Sample purchase order (demo data).',
      isDemo: true,
    },
  ];

  // Demo categories derived from the demo products (demo-cat-* namespace).
  const demoCategories = Array.from(new Set(demoProducts.map((p) => p.category)))
    .sort()
    .map((name, idx) => ({
      id: `demo-cat-${String(idx + 1).padStart(2, '0')}`,
      name,
      code: `DEMO_${name.toUpperCase().replace(/\s+/g, '_').slice(0, 12)}`,
      description: `${name} Inventory Category (demo)`,
      isDemo: true,
    }));

  return {
    suppliers: demoSuppliers,
    categories: demoCategories,
    products: demoProducts,
    inventoryStock: demoInventoryStock,
    assetRegister: demoAssetRegister,
    purchaseOrders: demoPurchaseOrders,
    purchaseInvoices: [],
    shipments: [],
    stockOperations: [],
    auditTrail: [],
    transactionLogs: [],
    customerMasterRecords: [],
    customerDeviceRecords: [],
    approvalRequests: [],
    damageRecords: demoDamageRecords,
    locations: [
      {
        id: 'LOC-001',
        name: 'Example Location 1 - Server Room',
        type: 'POP_SERVER_ROOM',
        branchId: 'WH001',
        address: 'Example Street, Example City, Nepal',
        coordinates: { latitude: 0, longitude: 0 },
        contactPerson: 'Example Contact 1',
        contactPhone: '9800000001',
        notes: 'Dummy location for testing (example data).',
        activeAssetsCount: 0,
        isDemo: true,
      },
      {
        id: 'LOC-002',
        name: 'Example Location 2 - Warehouse',
        type: 'WAREHOUSE',
        branchId: 'BRH01',
        address: 'Example Avenue, Example City, Nepal',
        coordinates: { latitude: 0, longitude: 0 },
        contactPerson: 'Example Contact 2',
        contactPhone: '9800000002',
        notes: 'Dummy location for testing (example data).',
        activeAssetsCount: 0,
        isDemo: true,
      },
    ],
    customerRecords: [
      {
        id: 'CUS-10291',
        customerId: 'CUS-10291',
        customerName: 'Example Customer 1',
        username: 'example.customer1',
        contactNumber: '9800000011',
        branchId: 'WH001',
        address: 'Example Street, Example City, Nepal',
        email: 'example.customer1@example.com',
        status: 'ACTIVE',
        creditLimit: 50000,
        assignedDevicesCount: 0,
        isDemo: true,
      },
      {
        id: 'CUS-10292',
        customerId: 'CUS-10292',
        customerName: 'Example Customer 2',
        username: 'example.customer2',
        contactNumber: '9800000012',
        branchId: 'BRH01',
        address: 'Example Avenue, Example City, Nepal',
        email: 'example.customer2@example.com',
        status: 'ACTIVE',
        creditLimit: 75000,
        assignedDevicesCount: 0,
        isDemo: true,
      },
      {
        id: 'CUS-10293',
        customerId: 'CUS-10293',
        customerName: 'Example Customer 3',
        username: 'example.customer3',
        contactNumber: '9800000013',
        branchId: 'WH001',
        address: 'Example Road, Example City, Nepal',
        email: 'example.customer3@example.com',
        status: 'ACTIVE',
        creditLimit: 100000,
        assignedDevicesCount: 0,
        isDemo: true,
      },
      {
        id: 'CUS-10294',
        customerId: 'CUS-10294',
        customerName: 'Example Customer 4',
        username: 'example.customer4',
        contactNumber: '9800000014',
        branchId: 'BRH01',
        address: 'Example Lane, Example City, Nepal',
        email: 'example.customer4@example.com',
        status: 'ACTIVE',
        creditLimit: 60000,
        assignedDevicesCount: 0,
        isDemo: true,
      },
    ],
  };
}

export default buildDemoDataset;
