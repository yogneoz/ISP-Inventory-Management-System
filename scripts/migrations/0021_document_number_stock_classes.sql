-- NUM-1: register the stock classes the Stock Operations screen actually
-- issues so every number shown in the app has a row in Document Classes &
-- Numbering. Existing installs get these on boot from seedData as well; this
-- migration closes the gap without touching any issued number.
INSERT INTO document_number_configs (id, document_type, prefix, suffix, min_digits, starting_number, next_number, reset_every_fiscal_year, notes)
VALUES
  ('DMG', 'Damage Write-off', 'DMG-2081-', '', 4, 1, 1, TRUE, 'Issued for damaged-stock write-offs from Stock Operations.'),
  ('PLT', 'Pullout Dispatch', 'PLT-2081-', '', 4, 1, 1, TRUE, 'Issued for pullout dispatches from Stock Operations.'),
  ('SALE', 'Stock Sale Reference', 'SALE-2081-', '', 4, 1, 1, TRUE, 'Issued for stock-out sale references created by Stock Operations.'),
  ('CON', 'Consumable Issue', 'CON-2081-', '', 4, 1, 1, TRUE, 'Issued for consumable issues created by Stock Operations.'),
  ('DSP', 'Stock Disposal', 'DSP-2081-', '', 4, 1, 1, TRUE, 'Issued for stock disposals created by Stock Operations.')
ON CONFLICT (id) DO NOTHING;
