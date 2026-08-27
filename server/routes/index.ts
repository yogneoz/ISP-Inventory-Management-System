/**
 * Mount all API route modules.
 */
import type { Express } from 'express';
import syncRoutes from './sync';
import bootstrapRoutes from './bootstrap';
import adminRoutes from './admin';
import authRoutes from './auth';
import mastersRoutes from './masters';
import catalogRoutes from './catalog';
import stockRoutes from './stock';
import procurementRoutes from './procurement';
import logisticsRoutes from './logistics';
import fiscalRoutes from './fiscal';
import auditRoutes from './audit';
import customersRoutes from './customers';
import approvalsRoutes from './approvals';
import reportsRoutes from './reports';
import companyRoutes from './company';
import aiRoutes from './ai';

export function registerRoutes(app: Express) {
  // Each module defines full paths like /api/...
  app.use(syncRoutes);
  app.use(bootstrapRoutes);
  app.use(adminRoutes);
  app.use(authRoutes);
  app.use(mastersRoutes);
  app.use(catalogRoutes);
  app.use(stockRoutes);
  app.use(procurementRoutes);
  app.use(logisticsRoutes);
  app.use(fiscalRoutes);
  app.use(auditRoutes);
  app.use(customersRoutes);
  app.use(approvalsRoutes);
  app.use(reportsRoutes);
  app.use(companyRoutes);
  app.use(aiRoutes);
}
