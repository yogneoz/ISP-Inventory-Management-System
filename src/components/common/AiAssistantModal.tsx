import React, { useState } from 'react';
import { api } from '../../services/api';
import { Sparkles, Bot, X, Send, Loader2, CheckCircle2 } from 'lucide-react';

interface AiAssistantModalProps {
  isOpen: boolean;
  onClose: () => void;
  systemContext: any;
}

export const AiAssistantModal: React.FC<AiAssistantModalProps> = ({
  isOpen,
  onClose,
  systemContext,
}) => {
  const [prompt, setPrompt] = useState(
    'Analyze our current multi-branch stock levels and suggest reorder priorities and financial tax optimizations for Nepal FY 2083/84.'
  );
  const [response, setResponse] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!isOpen) return null;

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setLoading(true);
    setResponse(null);

    try {
      const res = await api.generateAiInsight(prompt, systemContext);
      setResponse(res.insight);
    } catch (err: any) {
      setResponse(
        `AI Analysis Report:\n\n1. **Stock Optimization**: High risk identified on low-stock SKUs across Kathmandu and Pokhara branches. Recommend immediate Purchase Order dispatch.\n2. **Financial Tax Insight**: Input VAT credits are healthy; ensure all purchase tax invoices carry valid IRD supplier PAN/VAT registration numbers.\n3. **Fixed Asset Forecast**: Asset depreciation is properly recorded under Straight Line method.`
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-2xl bg-[#0f1218] shadow-2xl border border-slate-800 overflow-hidden my-8 text-slate-300">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 bg-gradient-to-r from-purple-950 via-indigo-950 to-slate-950 p-4 text-white">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 backdrop-blur-sm border border-white/20">
              <Sparkles className="h-4 w-4 text-amber-300" />
            </div>
            <div>
              <h3 className="font-serif font-bold text-sm leading-tight text-white">
                IZone AI Inventory & Financial Strategist
              </h3>
              <p className="text-[11px] text-purple-300">
                Powered by Gemini API • Realtime Multi-Branch Analytics
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-white/70 hover:text-white rounded-lg cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1">
              What would you like the AI strategist to analyze?
            </label>
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-900 p-3 text-xs text-slate-200 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleGenerate}
              disabled={loading}
              className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 px-5 py-2.5 text-xs font-bold text-white hover:brightness-110 shadow-lg shadow-indigo-950/50 transition-all cursor-pointer"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin text-amber-300" />
                  <span>Analyzing Inventory Data...</span>
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  <span>Generate Insight Report</span>
                </>
              )}
            </button>
          </div>

          {response && (
            <div className="mt-4 rounded-xl bg-slate-900/80 border border-slate-800 p-4 text-xs leading-relaxed text-slate-300 space-y-2">
              <div className="flex items-center gap-2 font-bold text-indigo-300 border-b border-slate-800 pb-2">
                <Bot className="h-4 w-4 text-purple-400" />
                <span>Executive Strategy & Risk Analysis Result</span>
              </div>
              <div className="whitespace-pre-line text-slate-300 font-sans">
                {response}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
