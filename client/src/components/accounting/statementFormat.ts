import { formatNPR } from '../../utils/nprFormat';

export function money(value: number | string | null | undefined): string {
  return formatNPR(typeof value === 'string' ? Number(value) : value);
}

export function amountCell(value: number, emptyDash = true): string {
  return value === 0 && emptyDash ? '—' : money(value);
}
