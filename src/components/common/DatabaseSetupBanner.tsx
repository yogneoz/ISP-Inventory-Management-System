import React, { useState } from 'react';
import { Database, AlertTriangle, Terminal, RefreshCw, CheckCircle2, ChevronRight, X, ExternalLink } from 'lucide-react';

interface DatabaseSetupBannerProps {
  isDarkMode?: boolean;
  onRefresh?: () => void;
  postgresConfig?: {
    host: string;
    port: number;
    database: string;
    user: string;
    isConnected: boolean;
    errorDetails?: string;
  };
}

export const DatabaseSetupBanner: React.FC<DatabaseSetupBannerProps> = ({
  isDarkMode = false,
  onRefresh,
  postgresConfig = {
    host: 'localhost',
    port: 5432,
    database: 'inventory_db',
    user: 'inventory_user',
    isConnected: false,
  },
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(false);
  const [copiedStep, setCopiedStep] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState<boolean>(false);

  const handleCopy = (text: string, stepId: string) => {
    navigator.clipboard.writeText(text);
    setCopiedStep(stepId);
    setTimeout(() => setCopiedStep(null), 2500);
  };

  const handleRetry = async () => {
    setIsChecking(true);
    try {
      if (onRefresh) {
        await onRefresh();
      }
    } finally {
      setTimeout(() => setIsChecking(false), 800);
    }
  };

  if (postgresConfig.isConnected) {
    return null;
  }

  const bashCommand = `npm run setup:postgres`;
  const dockerCommand = `docker run --name inventory_postgres -e POSTGRES_DB=inventory_db -e POSTGRES_USER=inventory_user -e POSTGRES_PASSWORD=securepassword -p 5432:5432 -d postgres:16-alpine`;
  const envExample = `DATABASE_URL="postgres://inventory_user:securepassword@localhost:5432/inventory_db"
POSTGRES_HOST="localhost"
POSTGRES_PORT="5432"
POSTGRES_DB="inventory_db"
POSTGRES_USER="inventory_user"
POSTGRES_PASSWORD="securepassword"`;

  return (
    <div
      id="db-setup-notification-banner"
      className={`border-b transition-colors shadow-xs ${
        isDarkMode
          ? 'bg-amber-950/40 border-amber-800/60 text-amber-200'
          : 'bg-gradient-to-r from-amber-50 via-orange-50 to-amber-50 border-amber-300 text-amber-900'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 py-2.5 sm:px-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2.5">
          {/* Left Title & Status */}
          <div className="flex items-start sm:items-center gap-3">
            <div className="flex-shrink-0 mt-0.5 sm:mt-0 p-1.5 rounded-lg bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-400/40">
              <Database className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-xs sm:text-sm tracking-tight flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 inline" />
                  PostgreSQL Database Setup Required (Self-Hosted Mode)
                </span>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-amber-200/70 text-amber-900 dark:bg-amber-900/60 dark:text-amber-300 border border-amber-400/40">
                  PostgreSQL Offline
                </span>
              </div>
              <p className="text-[11px] sm:text-xs opacity-90 mt-0.5">
                The application is configured to run on your own PostgreSQL server. Connect your local/on-premise PostgreSQL instance to enable direct database operations.
              </p>
            </div>
          </div>

          {/* Right Action Controls */}
          <div className="flex items-center gap-2 self-end sm:self-auto flex-wrap">
            <button
              id="btn-retry-db-connection"
              onClick={handleRetry}
              disabled={isChecking}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white shadow-xs transition-colors cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
              <span>{isChecking ? 'Checking Connection...' : 'Test Connection'}</span>
            </button>

            <button
              id="btn-toggle-db-setup-instructions"
              onClick={() => setIsExpanded(!isExpanded)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer border ${
                isDarkMode
                  ? 'border-amber-700/60 hover:bg-amber-900/40 text-amber-300'
                  : 'border-amber-300 hover:bg-amber-100 text-amber-800'
              }`}
            >
              <Terminal className="w-3.5 h-3.5" />
              <span>{isExpanded ? 'Hide Setup Commands' : 'Setup Instructions'}</span>
              <ChevronRight
                className={`w-3.5 h-3.5 transition-transform duration-200 ${
                  isExpanded ? 'rotate-90' : ''
                }`}
              />
            </button>
          </div>
        </div>

        {/* Expandable Setup Instructions Accordion */}
        {isExpanded && (
          <div
            className={`mt-3 pt-3 border-t grid grid-cols-1 md:grid-cols-3 gap-3 text-xs ${
              isDarkMode ? 'border-amber-800/60 text-slate-300' : 'border-amber-200 text-slate-700'
            }`}
          >
            {/* Step 1: Automated Script */}
            <div
              className={`p-3 rounded-lg border ${
                isDarkMode ? 'bg-slate-900/80 border-slate-800' : 'bg-white/80 border-amber-200 shadow-xs'
              }`}
            >
              <div className="flex items-center justify-between font-semibold mb-1.5 text-slate-900 dark:text-white">
                <span className="flex items-center gap-1.5">
                  <span className="w-4 h-4 rounded-full bg-amber-500 text-white flex items-center justify-center text-[10px]">
                    1
                  </span>
                  Automated Linux/Unix Script
                </span>
                <button
                  onClick={() => handleCopy(bashCommand, 'step1')}
                  className="text-[10px] text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer flex items-center gap-0.5"
                >
                  {copiedStep === 'step1' ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : 'Copy'}
                </button>
              </div>
              <p className="text-[11px] mb-2 text-slate-600 dark:text-slate-400">
                Runs automated PostgreSQL installer, user provisioning, and full schema migration.
              </p>
              <div className="font-mono text-[11px] bg-slate-950 text-slate-200 p-2 rounded border border-slate-800 overflow-x-auto select-all">
                {bashCommand}
              </div>
            </div>

            {/* Step 2: Docker Option */}
            <div
              className={`p-3 rounded-lg border ${
                isDarkMode ? 'bg-slate-900/80 border-slate-800' : 'bg-white/80 border-amber-200 shadow-xs'
              }`}
            >
              <div className="flex items-center justify-between font-semibold mb-1.5 text-slate-900 dark:text-white">
                <span className="flex items-center gap-1.5">
                  <span className="w-4 h-4 rounded-full bg-amber-500 text-white flex items-center justify-center text-[10px]">
                    2
                  </span>
                  Run via Docker (Instant)
                </span>
                <button
                  onClick={() => handleCopy(dockerCommand, 'step2')}
                  className="text-[10px] text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer flex items-center gap-0.5"
                >
                  {copiedStep === 'step2' ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : 'Copy'}
                </button>
              </div>
              <p className="text-[11px] mb-2 text-slate-600 dark:text-slate-400">
                Instantly spins up PostgreSQL 16 container with the required database credentials.
              </p>
              <div className="font-mono text-[11px] bg-slate-950 text-slate-200 p-2 rounded border border-slate-800 overflow-x-auto select-all">
                {dockerCommand}
              </div>
            </div>

            {/* Step 3: Environment Configuration */}
            <div
              className={`p-3 rounded-lg border ${
                isDarkMode ? 'bg-slate-900/80 border-slate-800' : 'bg-white/80 border-amber-200 shadow-xs'
              }`}
            >
              <div className="flex items-center justify-between font-semibold mb-1.5 text-slate-900 dark:text-white">
                <span className="flex items-center gap-1.5">
                  <span className="w-4 h-4 rounded-full bg-amber-500 text-white flex items-center justify-center text-[10px]">
                    3
                  </span>
                  Environment (.env)
                </span>
                <button
                  onClick={() => handleCopy(envExample, 'step3')}
                  className="text-[10px] text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer flex items-center gap-0.5"
                >
                  {copiedStep === 'step3' ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : 'Copy'}
                </button>
              </div>
              <p className="text-[11px] mb-2 text-slate-600 dark:text-slate-400">
                Ensure your server's <code className="font-mono">.env</code> contains your PostgreSQL connection details.
              </p>
              <pre className="font-mono text-[10px] bg-slate-950 text-slate-200 p-2 rounded border border-slate-800 overflow-x-auto select-all leading-tight">
                {envExample}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
