-- Worklist SCALE-3 follow-up: the 0036 swap recreated `serial_log` without
-- three column defaults the legacy table carried (`created_at`,
-- `status`, `source_type`). Schema.sql still declares them, so a fresh install
-- and an upgraded one differed in the one way that matters for a partitioned
-- table: an insert that relies on `DEFAULT CURRENT_TIMESTAMP` (the
-- customer-device flows insert without created_at) then routed a NULL date into
-- `serial_log_default` and failed its NOT NULL check.
--
-- PostgreSQL applies column defaults before routing a partitioned insert, so
-- restoring them is the whole fix. A BEFORE ROW trigger must NOT try to fill the
-- partition key itself: PostgreSQL refuses that with "moving row to another
-- partition during a BEFORE FOR EACH ROW trigger is not supported" (which is
-- exactly what this pass tried first). The function below is the version that
-- only reads the date, and the update guard still refuses to move a row.
ALTER TABLE serial_log ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE serial_log ALTER COLUMN status SET DEFAULT 'IN_STOCK';
ALTER TABLE serial_log ALTER COLUMN source_type SET DEFAULT 'PURCHASE';

CREATE OR REPLACE FUNCTION enforce_document_identity()
RETURNS trigger AS $$
DECLARE
  v_type TEXT := TG_ARGV[0];
  v_date_col TEXT := TG_ARGV[1];
  v_specs TEXT[] := TG_ARGV[2:array_upper(TG_ARGV, 1)];
  v_parts TEXT[];
  v_role TEXT;
  v_col TEXT;
  v_ci BOOLEAN;
  v_optional BOOLEAN;
  v_fixed BOOLEAN;
  v_refuse BOOLEAN;
  v_new TEXT;
  v_old TEXT;
  v_new_date DATE;
  v_old_date DATE;
  v_existing RECORD;
  v_inserted TEXT[] := '{}';
  i INT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM document_identity_registry WHERE document_type = v_type AND id = OLD.id;
    RETURN OLD;
  END IF;

  v_new_date := COALESCE((to_jsonb(NEW) ->> v_date_col)::date, CURRENT_DATE);
  IF TG_OP = 'UPDATE' THEN
    v_old_date := (to_jsonb(OLD) ->> v_date_col)::date;
    IF v_new_date IS DISTINCT FROM v_old_date THEN
      RAISE EXCEPTION 'a % row cannot move to another %: it is the partition key (row %). Reverse it and post a new document instead.', v_type, v_date_col, NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  FOR i IN 1 .. COALESCE(array_length(v_specs, 1), 0) LOOP
    v_parts := string_to_array(v_specs[i], ':');
    v_role := v_parts[1];
    v_col := v_parts[2];
    v_ci := 'ci' = ANY (v_parts[3:]);
    v_optional := 'optional' = ANY (v_parts[3:]);
    v_fixed := 'fixed' = ANY (v_parts[3:]);
    v_refuse := 'refuse' = ANY (v_parts[3:]);

    v_new := to_jsonb(NEW) ->> v_col;
    IF v_ci THEN v_new := lower(btrim(v_new)); END IF;
    IF v_optional AND (v_new IS NULL OR v_new = '') THEN v_new := NULL; END IF;

    IF TG_OP = 'UPDATE' THEN
      v_old := to_jsonb(OLD) ->> v_col;
      IF v_ci THEN v_old := lower(btrim(v_old)); END IF;
      IF v_optional AND (v_old IS NULL OR v_old = '') THEN v_old := NULL; END IF;
      IF v_new IS NOT DISTINCT FROM v_old THEN CONTINUE; END IF;
      IF v_fixed THEN
        RAISE EXCEPTION 'a % row cannot change its %: it is the registered business key (row %).', v_type, v_col, NEW.id
          USING ERRCODE = 'check_violation';
      END IF;
      DELETE FROM document_identity_registry
       WHERE document_type = v_type AND key_role = v_role AND id = NEW.id;
      IF v_new IS NOT NULL THEN
        INSERT INTO document_identity_registry (document_type, key_role, id, business_key, document_date)
        VALUES (v_type, v_role, NEW.id, v_new, v_new_date)
        ON CONFLICT (document_type, key_role, business_key) DO NOTHING;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'duplicate key value: another % document already holds % % (row %).', v_type, v_role, v_new, NEW.id
            USING ERRCODE = 'unique_violation';
        END IF;
      END IF;
      CONTINUE;
    END IF;

    IF v_new IS NULL THEN CONTINUE; END IF;

    SELECT business_key, document_date INTO v_existing
      FROM document_identity_registry
     WHERE document_type = v_type AND key_role = v_role AND id = NEW.id;
    IF FOUND THEN
      IF v_existing.business_key IS DISTINCT FROM v_new OR v_existing.document_date IS DISTINCT FROM v_new_date THEN
        IF v_fixed THEN
          RAISE EXCEPTION 'a % row cannot change its % or move to another %: both are registered (row %).', v_type, v_col, v_date_col, NEW.id
            USING ERRCODE = 'check_violation';
        END IF;
        IF array_length(v_inserted, 1) IS NOT NULL THEN
          DELETE FROM document_identity_registry
           WHERE document_type = v_type AND key_role = ANY (v_inserted) AND id = NEW.id;
        END IF;
        RETURN NULL;
      END IF;
      CONTINUE;
    END IF;

    INSERT INTO document_identity_registry (document_type, key_role, id, business_key, document_date)
    VALUES (v_type, v_role, NEW.id, v_new, v_new_date)
    ON CONFLICT (document_type, key_role, business_key) DO NOTHING;
    IF NOT FOUND THEN
      IF v_refuse THEN
        RAISE EXCEPTION 'duplicate key value: another % document already holds % % (row %).', v_type, v_role, v_new, NEW.id
          USING ERRCODE = 'unique_violation';
      END IF;
      IF array_length(v_inserted, 1) IS NOT NULL THEN
        DELETE FROM document_identity_registry
         WHERE document_type = v_type AND key_role = ANY (v_inserted) AND id = NEW.id;
      END IF;
      RETURN NULL;
    END IF;
    v_inserted := v_inserted || v_role;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
