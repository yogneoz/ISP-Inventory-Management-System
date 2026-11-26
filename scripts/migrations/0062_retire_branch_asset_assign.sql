-- 0062 — retire `branch-asset-assign`.
--
-- The cell was screen access, not an authority of its own: it gated both the
-- Assign Fixed Asset form and the Asset Deployments register. Those two screens
-- are different things, so the grant is split where it belonged all along —
-- the form writes a deployment (`stock-deploy`) and the register is an asset
-- read (`assets-view`). Auditors, who may read the asset register, now see what
-- was deployed without being able to deploy; accountants, who may maintain the
-- register, no longer see a form their deploy grant would refuse.
--
-- The operation is gone from DEFAULT_PERMISSIONS_MATRIX, so the boot seed can
-- never re-create it. This removes the rows an existing database still carries:
-- the matrix is the source of truth, not a museum of retired grants.
--
-- Idempotent: a fresh install (seed runs after migrations) has no row to delete.

DELETE FROM permission_matrix WHERE operation_id = 'branch-asset-assign';
