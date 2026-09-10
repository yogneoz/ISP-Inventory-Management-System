#!/usr/bin/env node
/**
 * Repair broken flattened ternaries in className template literals.
 *
 * The dark-mode migration scripts incorrectly flattened real JS ternaries
 * into literal text inside template strings:
 *   BROKEN:  className={`... 'tab === 'ALL ? bg-indigo-600 ... : bg-white ...`}
 *   CORRECT: className={`... ${tab === 'ALL' ? 'bg-indigo-600 ...' : 'bg-white ...'}`}
 *
 * This script detects every line where a real ternary was turned into
 * dead literal text (template literal with no ${} but containing ? and :)
 * and restores proper `${condition ? 'trueClasses' : 'falseClasses'}` syntax.
 *
 * Run:  node scripts/fix-flattened-ternaries.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..');

const FILES = [
  'src/features/dashboard/Dashboard.tsx',
  'src/components/layout/Sidebar.tsx',
  'src/components/layout/Header.tsx',
  'src/features/finance/AuditTrailReports.tsx',
  'src/features/finance/DepreciationRegister.tsx',
  'src/features/finance/FiscalYearManagement.tsx',
  'src/features/finance/FiscalYearClosingWizard.tsx',
  'src/features/finance/NepaliFiscalManagement.tsx',
  'src/features/finance/OpeningStockManager.tsx',
  'src/features/finance/VatRegister.tsx',
  'src/features/finance/BsCalendarUtility.tsx',
  'src/features/inventory/PhysicalStockAudit.tsx',
  'src/features/inventory/StockOperations.tsx',
  'src/features/inventory/ProductManagement.tsx',
  'src/features/inventory/ProductSearchBar.tsx',
  'src/features/inventory/BranchStockTracking.tsx',
  'src/features/inventory/DamagedStockTracking.tsx',
  'src/features/inventory/ExportStock.tsx',
  'src/features/inventory/ReorderStockTracking.tsx',
  'src/features/inventory/StockMovementLedger.tsx',
  'src/features/inventory/StockValuation.tsx',
  'src/features/inventory/ImportStock.tsx',
  'src/features/procurement/PurchaseOrders.tsx',
  'src/features/procurement/PurchaseInvoices.tsx',
  'src/features/procurement/ReceiveInboundWarehouse.tsx',
  'src/features/procurement/Shipments.tsx',
  'src/features/sales/CustomerMasterDirectory.tsx',
  'src/features/sales/ImportCustomers.tsx',
  'src/features/sales/CustomersManagement.tsx',
  'src/features/settings/ApprovalWorkflowCenter.tsx',
  'src/features/settings/CompanySetupManagement.tsx',
  'src/features/settings/DataRecalculationMaintenance.tsx',
  'src/components/common/HelpDocumentation.tsx',
];

/**
 * Find the ternary separator ` : ` in a flattened class string.
 * We need the ` : ` that separates the true-classes from false-classes,
 * NOT colons inside class names like `hover:text-slate-900`.
 *
 * Strategy: scan left-to-right for ` : ` (space-colon-space).
 * The first one after the ` ? ` that has a space AFTER the colon
 * (i.e. ` : ` followed by a space or end) is our separator.
 * In Tailwind class lists, `:` is always immediately followed by
 * a word character (e.g. `hover:bg`), never by a space. The ternary
 * separator ` : ` always has a space after it.
 */
function findTernarySeparator(str) {
  // Search for ` : ` (space-colon-space)
  let i = 0;
  while (i < str.length - 2) {
    if (str[i] === ' ' && str[i + 1] === ':' && str[i + 2] === ' ') {
      // Check: is this truly the ternary separator?
      // In class lists, `:` is followed by a letter (e.g. hover:text).
      // In ternary separator, `:` is followed by a space.
      // The ` : ` pattern already ensures space after `:`, so this IS the separator.
      return i;
    }
    i++;
  }
  return -1;
}

/**
 * Parse a broken flattened ternary from a template literal's inner content.
 * Returns { prefix, condition, trueClasses, falseClasses } or null.
 *
 * The content looks like:
 *   "px-3 ... 'tab === 'ALL ? bg-indigo-600 text-white : bg-white ..."
 *                         ^                                ^
 *                    condition starts                   separator
 *
 * We find the ` ? ` then the ` : ` after it. The content before ` ? `
 * is prefix+condition which we split by finding where the condition starts.
 */
function parseBrokenTernary(templateContent) {
  // Find the first ` ? ` — this marks start of ternary
  const qIdx = templateContent.indexOf(' ? ');
  if (qIdx === -1) return null;

  const beforeQ = templateContent.slice(0, qIdx);
  const rest = templateContent.slice(qIdx + 3); // after ` ? `

  // Find the ternary separator ` : ` in the rest
  const sepIdx = findTernarySeparator(rest);
  if (sepIdx === -1) return null;

  const trueClasses = rest.slice(0, sepIdx).trim();
  const falseClasses = rest.slice(sepIdx + 3).trim(); // skip ` : `

  // ════════════════════════════════════════════════════════════════
  // Split beforeQ into prefix + condition by finding the last
  // comparison operator. Operators always appear WITHIN the condition
  // and never in the prefix (which is pure CSS class text).
  //
  // Search order: `===`, `!==`, `>=`, `<=`, `&&`, `||`, then `>`, `<`.
  // For `>` and `<`, require a space on both sides to avoid false matches
  // in CSS class names.
  // ════════════════════════════════════════════════════════════════
  let lastOpIdx = -1;
  let opLen = 0;
  const searchOps = [
    { pat: ' === ', len: 5 }, { pat: ' !== ', len: 5 },
    { pat: ' >= ', len: 4 },  { pat: ' <= ', len: 4 },
    { pat: ' && ', len: 5 },  { pat: ' || ', len: 5 },
    { pat: ' > ', len: 3 },   { pat: ' < ', len: 3 },
  ];
  for (const { pat, len } of searchOps) {
    const idx = beforeQ.lastIndexOf(pat);
    if (idx > lastOpIdx) { lastOpIdx = idx; opLen = len; }
  }

  if (lastOpIdx === -1) {
    // No operator found — the condition is the last token before ` ? `
    let pos = beforeQ.length;
    while (pos > 0 && beforeQ[pos - 1] === ' ') pos--;
    while (pos > 0 && beforeQ[pos - 1] !== ' ') pos--;
    const prefix = beforeQ.slice(0, pos);
    const condition = beforeQ.slice(pos);
    if (!condition.trim()) return null;
    return { prefix, condition: condition.trim(), trueClasses, falseClasses };
  }

  // Found an operator at lastOpIdx (start of ` === ` etc.)
  // The right operand is between the operator end and the ` ? `
  const opEnd = lastOpIdx + opLen; // index right after the operator's trailing space
  const rightOperandEnd = beforeQ.length;

  // Walk backwards from rightOperandEnd through the right operand
  let rPos = rightOperandEnd;
  while (rPos > opEnd && beforeQ[rPos - 1] === ' ') rPos--;
  while (rPos > opEnd && beforeQ[rPos - 1] !== ' ') rPos--;
  // rPos is now at the start of the right operand

  // The operator starts at lastOpIdx + 1 (skip the leading space)
  const opStartInText = lastOpIdx + 1;

  // The left operand is before the operator's leading space
  let leftPos = lastOpIdx; // at the space before the operator
  while (leftPos > 0 && beforeQ[leftPos - 1] === ' ') leftPos--;
  // Walk backwards through the left operand
  let leftStart = leftPos;
  while (leftStart > 0 && beforeQ[leftStart - 1] !== ' ') leftStart--;

  // Check for prefix operators: !, ~, - (unary)
  if (leftStart > 0 && (beforeQ[leftStart - 1] === '!' || beforeQ[leftStart - 1] === '~' || beforeQ[leftStart - 1] === '-')) {
    leftStart--;
  }

  const condition = beforeQ.slice(leftStart);
  const prefix = beforeQ.slice(0, leftStart);

  if (!condition.trim()) return null;
  return { prefix, condition: condition.trim(), trueClasses, falseClasses };
}

/**
 * Walk backwards through `text` to find where the condition expression
 * starts. Returns the index of the first character of the condition.
 *
 * Strategy: walk backwards. When we see `SPACE WORD`:
 *  - If WORD starts with a known Tailwind class prefix (bg-, border-, text-,
 *    shadow-, hover:, dark:, ring-, etc.), that space is the PREFIX/CONDITION
 *    boundary → we stop.
 *  - If WORD looks like a JS operator or doesn't match any class prefix,
 *    the space is INSIDE the condition → we keep walking.
 */
function findConditionStart(beforeQ) {
  const trimmed = beforeQ.trimEnd();

  // ════════════════════════════════════════════════════════════════
  // PATH 1: Quoted condition (beforeQ ends with a closing ')
  // e.g. `'tab === 'ALL`, `'seedStatus.type === 'success`
  // Strategy: find the last comparison operator, then the opening ' of the value
  // ════════════════════════════════════════════════════════════════
  if (trimmed.endsWith("'")) {
    // Find the last comparison operator
    let lastOpIdx = -1;
    const opPatterns = [' === ', ' !== ', ' >= ', ' <= ', ' > ', ' < ', ' && ', ' || '];
    for (const pat of opPatterns) {
      const idx = beforeQ.lastIndexOf(pat);
      if (idx > lastOpIdx) lastOpIdx = idx;
    }
    if (lastOpIdx !== -1) {
      // Walk backwards from the operator to find the left operand
      let p = lastOpIdx;
      while (p > 0 && beforeQ[p - 1] === ' ') p--;
      while (p > 0 && beforeQ[p - 1] !== ' ') p--;
      return p;
    }
    // No operator found: condition is just 'varName (no ===)
    // Walk backwards from the closing ' to find the opening '
    let p = trimmed.length - 1; // at the closing '
    while (p > 0 && beforeQ[p - 1] === ' ') p--;
    if (p > 0 && beforeQ[p - 1] === "'") {
      p--; // at the opening '
      while (p > 0 && beforeQ[p - 1] === ' ') p--;
      while (p > 0 && beforeQ[p - 1] !== ' ') p--;
      return p;
    }
    // Fallback: just take the last word
    let p2 = trimmed.length;
    while (p2 > 0 && beforeQ[p2 - 1] === ' ') p2--;
    while (p2 > 0 && beforeQ[p2 - 1] !== ' ') p2--;
    return p2;
  }

  // ════════════════════════════════════════════════════════════════
  // PATH 2: Bare condition (no trailing ')
  // e.g. `isExpanded`, `editingProduct`, `totalOnHand <= X`, `qtyOnHand > 0`
  // Strategy: backward walk, skipping operators and their operands,
  //           but also skipping CSS class names (contain hyphen after lowercase)
  // ════════════════════════════════════════════════════════════════
  const ALL_OPS = ['===', '!==', '>=', '<=', '&&', '||', '>', '<'];

  function isClassName(tok) {
    // CSS classes: bg-red-500, text-slate-800, hover:text-white, dark:bg-slate-900,
    // transition-colors, cursor-pointer, font-bold, rounded-xl, border, etc.
    // JS variables: isExpanded, editingProduct, hasStock, totalOnHand, etc.
    //
    // Key distinctions:
    // - Classes contain ':' (hover:, dark:, focus:) → always CSS
    // - Classes contain '-' followed by a digit (bg-500, text-800) → CSS
    // - Common utility words without hyphens: border, flex, grid, hidden, etc.
    if (tok.includes(':')) return true;
    if (/^[a-z]+-\d/.test(tok)) return true;
    const CSS_WORDS = new Set([
      'border', 'flex', 'grid', 'hidden', 'absolute', 'relative', 'fixed',
      'sticky', 'static', 'block', 'inline', 'table', 'contents', 'list-item',
      'truncate', 'underline', 'italic', 'uppercase', 'lowercase', 'capitalize',
      'antialiased', 'isolate', 'sr-only', 'not-sr-only', 'grow', 'shrink',
      'overflow-hidden', 'overflow-auto', 'overflow-scroll', 'overflow-visible',
      'overflow-x-auto', 'overflow-y-auto', 'overflow-x-scroll', 'overflow-y-scroll',
      'whitespace-nowrap', 'whitespace-normal', 'break-normal', 'break-words',
      'break-all', 'break-keep',
    ]);
    if (CSS_WORDS.has(tok)) return true;
    // Classes starting with known utility prefixes followed by hyphen + value
    const CSS_PREFIXES = [
      'bg-', 'text-', 'border-', 'shadow-', 'ring-', 'font-', 'p-', 'px-', 'py-',
      'pt-', 'pr-', 'pb-', 'pl-', 'm-', 'mx-', 'my-', 'mt-', 'mr-', 'mb-', 'ml-',
      'gap-', 'space-', 'w-', 'h-', 'min-', 'max-', 'basis-', 'z-', 'inset-',
      'top-', 'right-', 'bottom-', 'left-', 'opacity-', 'rounded', 'cursor-',
      'transition-', 'duration-', 'ease-', 'delay-', 'animate-', 'scale-', 'rotate-',
      'translate-', 'skew-', 'origin-', 'justify-', 'items-', 'self-', 'content-',
      'place-', 'col-', 'row-', 'order-', 'select-', 'resize-', 'accent-',
      'caret-', 'decoration-', 'outline-', 'fill-', 'stroke-', 'drop-', 'backdrop-',
      'blur-', 'divide-', 'placeholder-', 'tracking-', 'leading-', 'indent-', 'list-',
      'from-', 'via-', 'to-', 'shrink-', 'grow-', 'basis-', 'pointer-events-',
      'text-[', // arbitrary text sizes
    ];
    if (CSS_PREFIXES.some(p => tok.startsWith(p))) return true;
    // Responsive/state variants: sm:, md:, lg:, xl:, 2xl:, group-, peer-
    if (/^(sm|md|lg|xl|2xl|group|peer|first|last|odd|even|disabled|checked|focus|hover|active|open|closed):/.test(tok)) return true;
    return false;
  }

  let pos = beforeQ.length;
  while (pos > 0) {
    while (pos > 0 && beforeQ[pos - 1] === ' ') pos--;
    if (pos === 0) return 0;
    let tokenEnd = pos;
    while (pos > 0 && beforeQ[pos - 1] !== ' ') pos--;
    const token = beforeQ.slice(pos, tokenEnd);
    const hasSpaceBefore = pos > 0 && beforeQ[pos - 1] === ' ';

    if (!hasSpaceBefore) return pos;

    // Is the token itself a JS operator?
    if (ALL_OPS.includes(token)) {
      pos--;
      continue;
    }

    // Is the token FOLLOWED BY a JS operator? (left operand)
    const afterSpace = beforeQ.slice(tokenEnd + 1);
    if (afterSpace) {
      const nextSpaceIdx = afterSpace.indexOf(' ');
      const nextToken = nextSpaceIdx !== -1 ? afterSpace.slice(0, nextSpaceIdx) : afterSpace;
      if (ALL_OPS.includes(nextToken)) {
        pos--;
        continue;
      }
      // Does afterSpace start with a quoted value? (e.g., `'success ?`)
      if (afterSpace.trimStart().startsWith("'")) {
        pos--;
        continue;
      }
    }

    // Is the PREVIOUS token a JS operator? (right operand)
    if (beforeQ[pos - 1] === ' ') {
      let prevEnd = pos - 1;
      while (prevEnd > 0 && beforeQ[prevEnd - 1] === ' ') prevEnd--;
      if (prevEnd > 0) {
        let prevStart = prevEnd;
        while (prevStart > 0 && beforeQ[prevStart - 1] !== ' ') prevStart--;
        const prevToken = beforeQ.slice(prevStart, prevEnd);
        if (ALL_OPS.includes(prevToken)) {
          pos--;
          continue;
        }
      }
    }

    // Is this token a CSS class name? If so, the space before it is the boundary.
    if (isClassName(token)) {
      return pos;
    }

    // Token is not an operator, not followed/preceded by one, and not a CSS class.
    // It could be part of the condition (e.g., a bare JS variable).
    // We need to keep walking to check if it's preceded by an operator.
    // BUT: if the token looks like a JS identifier (camelCase, starts with lowercase,
    // contains uppercase, etc.), it's likely the leftmost part of the condition.
    if (/^[a-z][a-zA-Z0-9]*$/.test(token) && !isClassName(token)) {
      // This looks like a JS variable name. Check if there's a space before it
      // that leads to more condition text, or if it's the leftmost token.
      // For now, return this as the condition start.
      return pos;
    }

    // Unknown token type — keep walking
    pos--;
  }
  return 0;
}

/**
 * Fix a broken condition string:
 *   "'tab === 'ALL"  →  "tab === 'ALL'"
 *   "isExpanded"      →  "isExpanded"
 *   "!requiresSerialTracking"  →  "!requiresSerialTracking"
 */
function fixCondition(cond) {
  let c = cond.trim();
  // Pattern: 'varName === 'VALUE' (fully quoted on both sides)
  const m = c.match(/^'(\w[\w.]*)\s*([<>=!]+)\s*'([^']*)'$/);
  if (m) return `${m[1]} ${m[2]} '${m[3]}'`;
  // Pattern: varName === 'VALUE (value may contain %, dots; missing closing quote)
  const m2 = c.match(/^'?([\w.]+)\s*([<>=!]+)\s*'([^']+)$/);
  if (m2) return `${m2[1]} ${m2[2]} '${m2[3]}'`;
  // Pattern: varName === VALUE (no quotes at all, numeric literal)
  const m3 = c.match(/^'?([\w.]+)\s*([<>=!]+)\s*([\w.]+)$/);
  if (m3) return `${m3[1]} ${m3[2]} ${m3[3]}`;
  // Remove leading stray quote from variable name
  if (c.startsWith("'")) c = c.slice(1);
  return c;
}

/**
 * Convert a broken line to its fixed form.
 *
 * INPUT:  `...prefix 'condition ? trueClasses : falseClasses`}
 * OUTPUT: `...prefix ${condition ? 'trueClasses' : 'falseClasses'}`}
 *
 * For lines that already have some correct interpolation alongside broken parts,
 * we only fix the broken part.
 */
function fixBrokenLine(line) {
  // Strategy: extract the broken ternary from the backtick template literal,
  // rebuild it with proper ${} interpolation.

  // Find the backtick template boundaries
  const backtickStart = line.indexOf('`');
  const backtickEnd = line.lastIndexOf('`');
  if (backtickStart === -1 || backtickEnd === -1 || backtickStart === backtickEnd) return null;

  const prefix = line.slice(0, backtickStart + 1); // everything up to and including opening `
  const suffix = line.slice(backtickEnd); // closing ` and anything after
  const templateContent = line.slice(backtickStart + 1, backtickEnd); // content inside `...`

  // Skip if this template already has proper ${} interpolation
  if (templateContent.includes('${')) return null;

  // The template content is all literal text — find the ternary pattern
  const parsed = parseBrokenTernary(templateContent);
  if (!parsed) return null;

  const { prefix: tplPrefix, condition: rawCondition, trueClasses, falseClasses } = parsed;
  const condition = fixCondition(rawCondition);

  // Rebuild: prefix + ${condition ? 'true' : 'false'} + suffix
  const newTemplate = `${tplPrefix}\${${condition} ? '${trueClasses}' : '${falseClasses}'}`;

  return `${prefix}${newTemplate}${suffix}`;
}

let totalFixed = 0;
let totalFiles = 0;

for (const f of FILES) {
  const filePath = join(ROOT, f);
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  let fixedCount = 0;
  const fixedLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only look at lines that look like they have a className template literal
    if (!line.includes('className') && !line.includes('<span className') && !line.includes('<td className') && !line.includes('<tr className') && !line.includes('<div className') && !line.includes('<label className') && !line.includes('className={')) continue;
    if (!line.includes('`')) continue;
    // Must NOT already have ${} interpolation (for the broken part)
    if (line.includes('${')) continue;
    // Must have the ternary indicators
    if (!line.includes(' ? ') || !line.includes(' : ')) continue;

    // CRITICAL: Only fix lines where the template content is purely CSS class text.
    // Skip lines with JSX elements (<span>, </span>), curly braces, or other code.
    const btStart = line.indexOf('`');
    const btEnd = line.lastIndexOf('`');
    if (btStart === -1 || btEnd === -1 || btStart === btEnd) continue;
    const tplContent = line.slice(btStart + 1, btEnd);
    if (/<[a-zA-Z]/.test(tplContent) || /<\/[a-zA-Z]/.test(tplContent) ||
        tplContent.includes('{') || tplContent.includes('}')) continue;

    const fixed = fixBrokenLine(line);
    if (fixed) {
      lines[i] = fixed;
      fixedCount++;
      fixedLines.push({ lineNo: i + 1, before: line.trim().slice(0, 120), after: fixed.trim().slice(0, 120) });
    }
  }

  if (fixedCount > 0) {
    totalFiles++;
    totalFixed += fixedCount;
    writeFileSync(filePath, lines.join('\n'), 'utf-8');
    console.log(`\n✅ ${f}: ${fixedCount} lines fixed`);
    for (const fl of fixedLines) {
      console.log(`  L${fl.lineNo}: ${fl.before}`);
      console.log(`       → ${fl.after}`);
    }
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Total: ${totalFixed} broken ternaries fixed across ${totalFiles} files`);
