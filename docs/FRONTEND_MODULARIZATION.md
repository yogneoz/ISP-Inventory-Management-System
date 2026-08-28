# Frontend modularization

## Completed
| Piece | Location |
|---|---|
| Stock ops shared types + tab resolver | `src/components/stockOps/types.ts` |
| Stock ops barrel | `src/components/stockOps/index.ts` |
| Inventory data/bootstrap hook | `src/app/useInventoryData.ts` |

`StockOperations.tsx` now imports `StockOpsTab` / `StockOperationsProps` / `resolveStockOpsTab` from the stockOps module instead of inlining them.

## Adopt the data hook (optional incremental)
`useInventoryData(enabled)` centralizes bootstrap fetch, cache, and SSE refresh.
Wire it into `App.tsx` when ready to delete the parallel `useState` blocks for products/stock/etc.

## Next panel extractions (optional)
1. `stockOps/PulloutBinPanel.tsx`
2. `stockOps/DamageTrackingPanel.tsx`
3. `stockOps/TransferPanels.tsx`
4. `stockOps/AssetAssignPanel.tsx`
5. `stockOps/DeviceExchangePanel.tsx`
6. `stockOps/StockOpsLogsPanel.tsx`

Keep `StockOperations.tsx` as the orchestrator that owns shared form state and passes slices into panels.
