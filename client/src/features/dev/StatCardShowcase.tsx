import React, { useState } from 'react';
import StatCard from '../../components/common/StatCard';
import type { StatCardTone } from '../../components/common/StatCard';
import {
  Package,
  Landmark,
  AlertTriangle,
  ShoppingCart,
  Truck,
  TrendingDown,
  Layers,
  DollarSign,
  RefreshCw,
} from 'lucide-react';
import { useDarkMode } from '../../contexts/DarkModeContext';

/**
 * DEV-ONLY — StatCard design-review gallery.
 *
 * Renders the shared StatCard component in every tone × variant × state so
 * tone tuning and contrast fixes can be reviewed at a glance (light + dark,
 * via the header theme toggle) instead of hunting through live screens.
 *
 * Reachable only through the hidden 'dev-statcard' nav tab (superadmin).
 */

const TONES: StatCardTone[] = ['indigo', 'sky', 'emerald', 'rose', 'amber', 'violet', 'slate'];

const TONE_META: Record<StatCardTone, { icon: React.ReactNode; label: string; value: string; hint: string }> = {
  indigo: { icon: <Package className="h-4 w-4" />, label: 'Indigo Tone', value: 'NPR 12,50,000', hint: 'Inventory asset value' },
  sky: { icon: <Truck className="h-4 w-4" />, label: 'Sky Tone', value: '14 Shipments', hint: 'In transit across branches' },
  emerald: { icon: <Landmark className="h-4 w-4" />, label: 'Emerald Tone', value: 'NPR 8,42,300', hint: 'Net credit position' },
  rose: { icon: <AlertTriangle className="h-4 w-4" />, label: 'Rose Tone', value: '6 SKUs', hint: 'Below reorder threshold' },
  amber: { icon: <DollarSign className="h-4 w-4" />, label: 'Amber Tone', value: 'NPR 45,200', hint: 'Estimated loss valuation' },
  violet: { icon: <Layers className="h-4 w-4" />, label: 'Violet Tone', value: '128 Devices', hint: 'Customer-assigned serials' },
  slate: { icon: <ShoppingCart className="h-4 w-4" />, label: 'Slate Tone', value: '312 Units', hint: 'Neutral default tone' },
};

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">{title}</h3>
        {note && <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">{note}</p>}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">{children}</div>
    </section>
  );
}

export const StatCardShowcase: React.FC = () => {
  const { isDarkMode, toggleTheme } = useDarkMode();
  const [filterA, setFilterA] = useState(false);
  const [filterB, setFilterB] = useState(false);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-serif font-bold tracking-tight flex items-center gap-2 text-slate-900 dark:text-white">
            <Package className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
            <span>StatCard Design Review</span>
          </h2>
          <p className="text-xs mt-1 text-slate-500 dark:text-slate-400">
            Every tone × variant × state of the shared StatCard component. Use the button (or the header theme toggle)
            to compare light / dark rendering side by side.
          </p>
        </div>
        <button
          onClick={toggleTheme}
          className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold border transition-all cursor-pointer shadow-xs bg-white border-slate-300 text-slate-700 hover:bg-slate-100 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          <RefreshCw className="h-4 w-4" />
          <span>Toggle theme (currently {isDarkMode ? 'dark' : 'light'})</span>
        </button>
      </div>

      {/* 1. Default variant — all tones, inert */}
      <Section
        title="Default variant — all tones"
        note="Compact mono numeral, as used on register/tool screens. Surface is always neutral; tone colors only the icon chip and value."
      >
        {TONES.map((tone) => (
          <StatCard
            key={tone}
            label={TONE_META[tone].label}
            value={TONE_META[tone].value}
            hint={TONE_META[tone].hint}
            icon={TONE_META[tone].icon}
            tone={tone}
          />
        ))}
      </Section>

      {/* 2. Hero variant — all tones */}
      <Section
        title="Hero variant — all tones"
        note="Larger serif display numeral — the Executive Dashboard style. Same surface, tones and layout."
      >
        {TONES.map((tone) => (
          <StatCard
            key={tone}
            variant="hero"
            label={TONE_META[tone].label}
            value={TONE_META[tone].value}
            hint={TONE_META[tone].hint}
            icon={TONE_META[tone].icon}
            tone={tone}
          />
        ))}
      </Section>

      {/* 3. Text-only (no icon) */}
      <Section title="Text-only (icon omitted)" note="Denser chip-less cards used by numeric ledgers (e.g. Stock Movement Ledger).">
        {(['emerald', 'sky', 'rose', 'indigo'] as StatCardTone[]).map((tone) => (
          <StatCard
            key={tone}
            label={`No-Icon ${tone}`}
            value="+NPR 84,500"
            hint="42 Units"
            tone={tone}
          />
        ))}
      </Section>

      {/* 4. Clickable + active toggle states */}
      <Section
        title="Interactive states"
        note="Clickable cards render as real buttons with hover ring + chevron. 'Active' adds the indigo ring (filter-toggle pattern, as on Physical Stock Audit)."
      >
        <StatCard
          label="Clickable — Inert"
          value="Click me"
          hint="Hover shows ring + arrow"
          icon={<ShoppingCart className="h-4 w-4" />}
          tone="indigo"
          onClick={() => undefined}
          title="Demo clickable card"
        />
        <StatCard
          label="Clickable — Active"
          value={filterA ? 'Filter ON' : 'Filter OFF'}
          hint="Toggle to see aria-pressed + ring"
          icon={<AlertTriangle className="h-4 w-4" />}
          tone="rose"
          onClick={() => setFilterA((v) => !v)}
          active={filterA}
          title="Demo active filter card"
        />
        <StatCard
          label="Clickable — Active (hero)"
          value={filterB ? 'Filter ON' : 'Filter OFF'}
          hint="Active state in hero variant"
          icon={<TrendingDown className="h-4 w-4" />}
          tone="amber"
          variant="hero"
          onClick={() => setFilterB((v) => !v)}
          active={filterB}
          title="Demo active hero card"
        />
        <StatCard
          label="Inert (reference)"
          value="Not clickable"
          hint="Plain div — no hover affordance"
          icon={<Landmark className="h-4 w-4" />}
          tone="slate"
        />
      </Section>

      {/* 5. Mixed-tone row (uniformity check) */}
      <Section
        title="Mixed-tone row uniformity"
        note="A realistic score-card row mixing tones, clickability and variants — all cards must read as one band."
      >
        <StatCard
          variant="hero"
          label="Total Stock Valuation"
          value="NPR 23,40,475"
          hint={<span className="flex w-full items-center justify-between"><span>28 SKU Locations</span><span className="font-medium text-indigo-600 dark:text-indigo-400">Cost Basis</span></span>}
          icon={<Package className="h-3.5 w-3.5" />}
          tone="indigo"
        />
        <StatCard
          variant="hero"
          label="Low Stock Alerts"
          value="2 SKUs"
          hint={<span className="flex w-full items-center justify-between"><span>Requires Action</span><span className="font-medium text-rose-600 dark:text-rose-400">View Reorder</span></span>}
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          tone="rose"
          onClick={() => undefined}
          title="Demo navigation card"
        />
        <StatCard
          label="Damaged Loss"
          value="-NPR 12,400"
          hint="-4 Units"
          tone="rose"
        />
        <StatCard
          label="Closing Value"
          value="NPR 23,28,075"
          hint="1,730 Units"
          className="col-span-2 sm:col-span-1"
          tone="indigo"
        />
      </Section>
    </div>
  );
};

export default StatCardShowcase;
