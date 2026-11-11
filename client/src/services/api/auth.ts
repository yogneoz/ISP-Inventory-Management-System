import type { User } from '../../types';
import { fetchJson } from './http';

export async function getSetupStatus(): Promise<{ isFirstLaunch: boolean; userCount: number; hasSuperAdmin: boolean }> {
  return fetchJson('/api/auth/setup-status');
}

export async function setupSuperAdmin(data: {
  name: string;
  email: string;
  password: string;
  branchId?: string;
  /** One-time boot token printed by the server (or SETUP_TOKEN in .env). */
  setupToken?: string;
}): Promise<{ user: User; token: string }> {
  return fetchJson('/api/auth/setup-superadmin', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function forgotPassword(email: string): Promise<{ success: boolean; message: string }> {
  return fetchJson('/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function login(email: string, password: string): Promise<{ user: User; token: string }> {
  return fetchJson('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function switchProfile(
  targetUserId: string,
  options?: { targetEmail?: string }
): Promise<{ user: User; token: string }> {
  return fetchJson('/api/auth/switch-profile', {
    method: 'POST',
    body: JSON.stringify({ targetUserId, ...(options?.targetEmail ? { targetEmail: options.targetEmail } : {}) }),
  });
}

/**
 * Self-service profile edit. The server requires `currentPassword` for any
 * change to email, branch or password, and returns a fresh `token` because the
 * edit retires every session issued before it.
 */
export async function updateProfile(
  data: Partial<User> & { newPassword?: string; currentPassword?: string }
): Promise<User & { token?: string }> {
  return fetchJson('/api/auth/profile', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}
