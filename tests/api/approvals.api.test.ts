import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../server/createApp';
import { initSessionStore } from '../../server/lib/sessionStore';
import { setDbMode, setPgConnected } from '../../server/lib/db';
import * as store from '../../server/store';
import { resetStoreForTests, seedBasicCatalog } from '../helpers/testStore';
import type { ApprovalRequest, CustomerDeviceRecord } from '../../src/types';

async function login(app: ReturnType<typeof createApp>, password: string) {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@test.local', password })
    .expect(200);
  return res.body.token as string;
}

describe('API approvals — create, reject, approve', () => {
  const app = createApp();
  let token = '';
  let adminPassword = 'TestAdmin@123';
  let device: CustomerDeviceRecord;

  beforeEach(async () => {
    setPgConnected(false);
    setDbMode('memory');
    await initSessionStore();
    const seeded = await resetStoreForTests({ withAdmin: true });
    adminPassword = seeded.adminPassword;
    seedBasicCatalog();

    device = {
      id: 'dev-1',
      customerId: 'cust-1',
      customerName: 'Ram Bahadur',
      customerCode: 'C-1001',
      contactPhone: '9800000099',
      installationAddress: 'Urlabari-4',
      branchId: 'WH001',
      productName: 'Test Fiber ONU',
      deviceSerial: 'SN-TEST-001',
      ponSerial: 'PON-TEST-001',
      macAddress: 'AA:BB:CC:DD:EE:01',
      status: 'ACTIVE',
      issuedDateAD: '2025-01-15',
      issuedDateBS: '2081-10-01 BS',
    };
    store.customerDeviceRecords.push(device);
    store.customerMasterRecords.push({
      id: 'cust-1',
      customerId: 'C-1001',
      customerName: 'Ram Bahadur',
      username: 'ram.b',
      contactNumber: '9800000099',
      branchId: 'WH001',
      address: 'Urlabari-4',
      status: 'ACTIVE',
      assignedDevicesCount: 1,
    });

    token = await login(app, adminPassword);
  });

  it('creates a pending approval request', async () => {
    const res = await request(app)
      .post('/api/approval-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'CUSTOMER_DEVICE_STATUS',
        targetId: device.id,
        customerName: device.customerName,
        customerCode: device.customerCode,
        deviceSerial: device.deviceSerial,
        ponSerial: device.ponSerial,
        productName: device.productName,
        currentStatus: 'ACTIVE',
        requestedStatus: 'DISCONNECTED',
        requestedByRole: 'FRONT_DESK',
        requestedByEmail: 'desk@test.local',
        requestedByName: 'Front Desk',
        branchId: 'WH001',
        branchName: 'Head Office',
        reason: 'Customer requested temporary disconnect',
      })
      .expect(201);

    expect(res.body.status).toBe('PENDING');
    expect(res.body.requestNumber).toMatch(/^APR-/);
    expect(store.approvalRequests.some((a) => a.id === res.body.id)).toBe(true);
  });

  it('rejects a pending request with a reason', async () => {
    const created = await request(app)
      .post('/api/approval-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'CUSTOMER_DEVICE_STATUS',
        targetId: device.id,
        customerName: device.customerName,
        deviceSerial: device.deviceSerial,
        productName: device.productName,
        currentStatus: 'ACTIVE',
        requestedStatus: 'DISCONNECTED',
        requestedByRole: 'FRONT_DESK',
        requestedByEmail: 'desk@test.local',
        requestedByName: 'Front Desk',
        branchId: 'WH001',
        reason: 'Disconnect request',
      })
      .expect(201);

    const res = await request(app)
      .post(`/api/approval-requests/${created.body.id}/process`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        status: 'REJECTED',
        rejectionReason: 'Outstanding dues remain',
      })
      .expect(200);

    expect(res.body.request.status).toBe('REJECTED');
    expect(res.body.request.rejectionReason).toMatch(/dues/i);
    // Device remains active when rejected
    const dev = store.customerDeviceRecords.find((d) => d.id === device.id)!;
    expect(dev.status).toBe('ACTIVE');
  });

  it('approves a disconnect request and updates device status', async () => {
    const created = await request(app)
      .post('/api/approval-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'CUSTOMER_DEVICE_STATUS',
        targetId: device.id,
        customerName: device.customerName,
        deviceSerial: device.deviceSerial,
        productName: device.productName,
        currentStatus: 'ACTIVE',
        requestedStatus: 'DISCONNECTED',
        requestedByRole: 'FRONT_DESK',
        requestedByEmail: 'desk@test.local',
        requestedByName: 'Front Desk',
        branchId: 'WH001',
        reason: 'Customer relocated',
      })
      .expect(201);

    const res = await request(app)
      .post(`/api/approval-requests/${created.body.id}/process`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'APPROVED' })
      .expect(200);

    expect(res.body.request.status).toBe('APPROVED');
    const dev = store.customerDeviceRecords.find((d) => d.id === device.id)!;
    // Disconnect flow maps to ROUTER_COLLECTED in process handler
    expect(['DISCONNECTED', 'ROUTER_COLLECTED']).toContain(dev.status);
  });

  it('lists approval requests for authenticated users', async () => {
    store.approvalRequests.push({
      id: 'apr-seed',
      requestNumber: 'APR-2083-001',
      type: 'CUSTOMER_DEVICE_STATUS',
      targetId: device.id,
      customerName: device.customerName,
      deviceSerial: device.deviceSerial,
      productName: device.productName,
      currentStatus: 'ACTIVE',
      requestedStatus: 'DISCONNECTED',
      requestedByRole: 'FRONT_DESK',
      requestedByEmail: 'desk@test.local',
      requestedByName: 'Front Desk',
      branchId: 'WH001',
      reason: 'seed',
      status: 'PENDING',
      requestedAtAD: new Date().toISOString(),
      requestedAtBS: '2083-01-01 BS',
    } as ApprovalRequest);

    const res = await request(app)
      .get('/api/approval-requests')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });
});
