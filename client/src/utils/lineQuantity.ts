/**
 * Client entry point for the line-quantity rule — the rule itself lives in
 * [shared/lineQuantity.ts](../../../shared/lineQuantity.ts) so the screens and
 * the API enforce the same ceiling (QTY-1). Screens keep importing from here.
 */
export { MAX_LINE_QUANTITY, clampLineQuantity, parseLineQuantity } from '../../../shared/lineQuantity';
