import React, { useState, useEffect } from 'react';
import {
  ShieldCheck,
  Lock,
  Mail,
  ArrowRight,
  AlertCircle,
  Eye,
  EyeOff,
  Building2,
  UserPlus,
  Crown,
  UserCheck,
  KeyRound,
  CheckCircle2,
  ArrowLeft,
  Sparkles,
} from 'lucide-react';
import { Branch } from '../../types';
import { api } from '../../services/api';

interface LoginModalProps {
  onLoginSuccess: (email: string, pass: string) => Promise<void>;
  onSetupSuperAdmin?: (data: { name: string; email: string; password: string; branchId?: string }) => Promise<void>;
  branches?: Branch[];
}

export const LoginModal: React.FC<LoginModalProps> = ({
  onLoginSuccess,
  onSetupSuperAdmin,
  branches = [],
}) => {
  const [mode, setMode] = useState<'LOGIN' | 'FIRST_TIME_SETUP' | 'FORGOT_PASSWORD'>('LOGIN');
  
  // Login State
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);

  // Setup State
  const [setupName, setSetupName] = useState('');
  const [setupEmail, setSetupEmail] = useState('');
  const [setupPassword, setSetupPassword] = useState('');
  const [setupConfirmPassword, setSetupConfirmPassword] = useState('');
  const [setupBranchId, setSetupBranchId] = useState(branches[0]?.id || 'WH001');

  // Forgot Password State
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotMsg, setForgotMsg] = useState<{ success: boolean; text: string } | null>(null);

  // General Status
  const [isFirstLaunch, setIsFirstLaunch] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Check setup status on load
  useEffect(() => {
    async function checkStatus() {
      try {
        const st = await api.getSetupStatus();
        if (st.hasSuperAdmin && st.userCount > 0) {
          setIsFirstLaunch(false);
          setMode('LOGIN');
        } else if (st.isFirstLaunch || st.userCount === 0 || !st.hasSuperAdmin) {
          setIsFirstLaunch(true);
          setMode('FIRST_TIME_SETUP');
        } else {
          setIsFirstLaunch(false);
          setMode('LOGIN');
        }
      } catch (e) {
        setIsFirstLaunch(false);
        setMode('LOGIN');
      }
    }
    checkStatus();
  }, []);

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onLoginSuccess(email, password);
    } catch (err: any) {
      setError(err.message || 'Invalid credentials. Please verify your email and password.');
    } finally {
      setLoading(false);
    }
  };

  const handleSetupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (setupPassword !== setupConfirmPassword) {
      setError('Passwords do not match. Please verify your password entry.');
      return;
    }

    if (setupPassword.length < 4) {
      setError('Password must be at least 4 characters long.');
      return;
    }

    setLoading(true);
    try {
      if (onSetupSuperAdmin) {
        await onSetupSuperAdmin({
          name: setupName,
          email: setupEmail,
          password: setupPassword,
          branchId: setupBranchId,
        });
      } else {
        await api.setupSuperAdmin({
          name: setupName,
          email: setupEmail,
          password: setupPassword,
          branchId: setupBranchId,
        });
        await onLoginSuccess(setupEmail, setupPassword);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to initialize Super Admin account.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setForgotMsg(null);
    setLoading(true);

    try {
      const res = await api.forgotPassword(forgotEmail);
      setForgotMsg({
        success: true,
        text: res.message,
      });
    } catch (err: any) {
      setError(err.message || 'No registered user account found with this email.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md p-4 animate-in fade-in duration-200 overflow-y-auto">
      <div className="w-full max-w-md overflow-hidden rounded-3xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200/80 dark:border-slate-800 transition-all my-8">
        {/* Modern Enterprise Header */}
        <div className="bg-gradient-to-br from-indigo-900 via-indigo-950 to-slate-950 p-6 text-white relative overflow-hidden text-center">
          {/* Subtle Ambient Background Lighting Glow */}
          <div className="absolute -top-12 -right-12 h-36 w-36 rounded-full bg-indigo-500/20 blur-2xl pointer-events-none" />
          <div className="absolute -bottom-12 -left-12 h-36 w-36 rounded-full bg-blue-500/20 blur-2xl pointer-events-none" />

          <div className="relative z-10 flex flex-col items-center">
            <div className="mb-2.5 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10 backdrop-blur-md border border-white/20 text-white font-serif font-extrabold text-xl shadow-xl">
              iZ
            </div>
            <h2 className="text-lg font-extrabold tracking-tight text-white font-serif">
              Inventory Management System
            </h2>
            <p className="text-[11px] text-indigo-200/90 mt-0.5 max-w-xs font-medium">
              Multi-Branch Inventory & Financial Control Portal
            </p>

            <div className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-indigo-500/20 px-3 py-0.5 text-[10px] font-semibold text-indigo-200 border border-indigo-400/30">
              {mode === 'FIRST_TIME_SETUP' ? (
                <>
                  <Crown className="h-3 w-3 text-amber-300" />
                  <span>Initial Super Admin Setup</span>
                </>
              ) : mode === 'FORGOT_PASSWORD' ? (
                <>
                  <KeyRound className="h-3 w-3 text-amber-300" />
                  <span>Credential Reset Help</span>
                </>
              ) : (
                <>
                  <Building2 className="h-3 w-3 text-indigo-300" />
                  <span>Enterprise Single Sign-On</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* First Time Launch Banner Alert */}
        {isFirstLaunch && mode === 'FIRST_TIME_SETUP' && (
          <div className="bg-amber-500/10 border-b border-amber-500/20 px-6 py-3 flex items-start gap-2.5 text-xs text-amber-800 dark:text-amber-200">
            <Sparkles className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-bold">First Time System Setup</p>
              <p className="text-[11px] text-amber-700 dark:text-amber-300 mt-0.5">
                No system users were detected. Create the initial Super Admin account below to activate full multi-branch access.
              </p>
            </div>
          </div>
        )}

        {/* MODE 1: LOGIN FORM */}
        {mode === 'LOGIN' && (
          <form onSubmit={handleLoginSubmit} className="p-6 space-y-4">
            {error && (
              <div className="flex items-center gap-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/50 p-3 text-xs text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900 animate-in slide-in-from-top-1">
                <AlertCircle className="h-4 w-4 flex-shrink-0 text-rose-600 dark:text-rose-400" />
                <span className="font-medium">{error}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                Email Address / User ID
              </label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="user@example.com"
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 pl-10 pr-3.5 py-2.5 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:border-indigo-500 focus:bg-white dark:focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all font-medium"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300">
                  Password
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setError('');
                    setMode('FORGOT_PASSWORD');
                  }}
                  className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                >
                  Forgot Password?
                </button>
              </div>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 pl-10 pr-10 py-2.5 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:border-indigo-500 focus:bg-white dark:focus:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all font-medium"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors p-1"
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
                <span className="text-xs font-medium text-slate-600 dark:text-slate-400">
                  Keep me logged in
                </span>
              </label>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white py-3 text-xs font-bold transition-all cursor-pointer shadow-lg shadow-indigo-600/25 disabled:opacity-70 disabled:cursor-not-allowed mt-2"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <div className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Verifying Credentials...</span>
                </span>
              ) : (
                <>
                  <span>Sign In to System</span>
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>

            {/* Security Assurance Badge */}
            <div className="pt-3 mt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-center gap-1.5 text-[11px] font-semibold text-slate-400 dark:text-slate-500">
              <ShieldCheck className="h-4 w-4 text-emerald-500" />
              <span>256-Bit Encrypted Multi-Branch Session</span>
            </div>
          </form>
        )}

        {/* MODE 2: FIRST TIME SETUP (CREATE SUPER ADMIN) */}
        {mode === 'FIRST_TIME_SETUP' && (
          <form onSubmit={handleSetupSubmit} className="p-6 space-y-3.5">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-900 dark:text-white">
                <Crown className="h-4 w-4 text-amber-500" />
                <span>Create Super Admin Account</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setError('');
                  setMode('LOGIN');
                }}
                className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1 cursor-pointer"
              >
                <ArrowLeft className="h-3 w-3" />
                <span>Back to Login</span>
              </button>
            </div>

            {error && (
              <div className="flex items-center gap-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/50 p-3 text-xs text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900 animate-in slide-in-from-top-1">
                <AlertCircle className="h-4 w-4 flex-shrink-0 text-rose-600 dark:text-rose-400" />
                <span className="font-medium">{error}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                Super Admin Full Name *
              </label>
              <input
                type="text"
                required
                value={setupName}
                onChange={(e) => setSetupName(e.target.value)}
                placeholder="e.g. Full Name"
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 px-3.5 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                Official Email Address *
              </label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="email"
                  required
                  value={setupEmail}
                  onChange={(e) => setSetupEmail(e.target.value)}
                  placeholder="superadmin@example.com"
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 pl-10 pr-3.5 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>

            {branches && branches.length > 0 && (
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Primary Headquarters Branch *
                </label>
                <select
                  value={setupBranchId}
                  onChange={(e) => setSetupBranchId(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 px-3.5 py-2 text-xs text-slate-900 dark:text-white focus:border-indigo-500 focus:outline-none"
                >
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.code})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Password *
                </label>
                <input
                  type="password"
                  required
                  value={setupPassword}
                  onChange={(e) => setSetupPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 px-3.5 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:border-indigo-500 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
                  Confirm Password *
                </label>
                <input
                  type="password"
                  required
                  value={setupConfirmPassword}
                  onChange={(e) => setSetupConfirmPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 px-3.5 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="p-3 rounded-xl bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800 text-[11px] text-purple-900 dark:text-purple-300">
              ✨ <strong>Super Admin Credentials</strong> grant full system privileges across all branches, financial statement approval, user management, and stock audit overrides.
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white py-3 text-xs font-bold transition-all cursor-pointer shadow-lg shadow-purple-600/25 disabled:opacity-70 disabled:cursor-not-allowed mt-2"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <div className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Creating Account & Provisioning...</span>
                </span>
              ) : (
                <>
                  <UserCheck className="h-4 w-4" />
                  <span>Create Super Admin & Launch Portal</span>
                </>
              )}
            </button>

            <div className="text-center pt-2">
              <button
                type="button"
                onClick={() => {
                  setError('');
                  setMode('LOGIN');
                }}
                className="text-xs text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer"
              >
                Already have an account? <span className="font-bold underline">Sign In</span>
              </button>
            </div>
          </form>
        )}

        {/* MODE 3: FORGOT PASSWORD */}
        {mode === 'FORGOT_PASSWORD' && (
          <form onSubmit={handleForgotPasswordSubmit} className="p-6 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-900 dark:text-white">
                <KeyRound className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                <span>Forgot / Reset Password Support</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setError('');
                  setForgotMsg(null);
                  setMode('LOGIN');
                }}
                className="text-[11px] font-bold text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1 cursor-pointer"
              >
                <ArrowLeft className="h-3 w-3" />
                <span>Back to Login</span>
              </button>
            </div>

            {error && (
              <div className="flex items-center gap-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/50 p-3 text-xs text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900 animate-in slide-in-from-top-1">
                <AlertCircle className="h-4 w-4 flex-shrink-0 text-rose-600 dark:text-rose-400" />
                <span className="font-medium">{error}</span>
              </div>
            )}

            {forgotMsg && (
              <div className="rounded-2xl bg-emerald-50 dark:bg-emerald-950/50 p-4 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-800 dark:text-emerald-200 space-y-2 animate-in zoom-in-95 duration-150">
                <div className="flex items-center gap-2 font-bold text-emerald-900 dark:text-emerald-100">
                  <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                  <span>Reset Request Registered!</span>
                </div>
                <p className="text-[11px] leading-relaxed">{forgotMsg.text}</p>
                <div className="pt-2 border-t border-emerald-200/60 dark:border-emerald-800/60 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                  💡 <strong>System Tip:</strong> System Administrators and Managers can instantly issue a new password for your account inside the <em>User & Staff Management</em> control panel.
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1.5">
                Enter your Registered Official Email
              </label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <input
                  type="email"
                  required
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  placeholder="e.g. user@example.com"
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/80 pl-10 pr-3.5 py-2.5 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:border-indigo-500 focus:outline-none"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white py-3 text-xs font-bold transition-all cursor-pointer shadow-lg shadow-indigo-600/25 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <div className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Verifying Account Email...</span>
                </span>
              ) : (
                <>
                  <span>Submit Reset Request</span>
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
