/**
 * The page numbers a pager renders: every page when they fit, otherwise the
 * first, the last and the current page ±1 with an ellipsis marking each gap.
 *
 * Shared by the offset pager (TablePagination) and the cursor footer so both
 * number pages identically.
 */
type PageWindowItem = number | 'gap-l' | 'gap-r';

export function pageWindow(page: number, pageCount: number): PageWindowItem[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const pages: PageWindowItem[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(pageCount - 1, page + 1);
  if (start > 2) pages.push('gap-l');
  for (let i = start; i <= end; i++) pages.push(i);
  if (end < pageCount - 1) pages.push('gap-r');
  pages.push(pageCount);
  return pages;
}
