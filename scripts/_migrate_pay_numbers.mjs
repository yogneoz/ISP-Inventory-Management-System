/* One-shot cleanup: delete remaining REVERSED old-format (BRH01-PAY-* /
   WH001-PAY-*) demo vendor-payment rows from vendor_payments so the
   sub-ledger has ZERO PAY-format leftovers and only doc-system numbers
   (CP/BP). These are already REVERSED demo leftovers — no live money. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const token = fs.readFileSync(path.join(__dirname, 'scripts', '.token.txt'), 'utf8').trim();
const h = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const api = 'http://localhost:3000';

const list = async () => {
  const res = await (await fetch(api + '/api/vendor-payments', { headers: h })).json();
  return Array.isArray(res) ? res : res.data || res.payments || res.vendorPayments || [];
};

(async () => {
  const arr = await list();
  const stale = arr.filter((p) => /^(BRH01-PAY-|WH001-PAY-|BRH01-PAY-|PAY-)/.test((p.paymentNumber || '')));
  console.log('Old-format (PAY-) rows remaining: ' + stale.length);
  for (const p of stale) {
    console.log('  DELETING ' + p.paymentNumber + ' | ' + p.paymentMethod + ' | ' + p.status + ' | id=' + p.id);
    const del = await fetch(api + '/api/vendor-payments/' + p.id, { method: 'DELETE', headers: h });
    console.log('    -> ' + del.status + ' ' + (del.ok ? 'deleted' : (await del.text()).slice(0, 140)));
  }

  const arr2 = await list();
  const still = (Array.isArray(arr2) ? arr2 : []).filter((p) => /^(BRH01-PAY-|WH001-PAY-|PAY-)/.test((p.paymentNumber || '')));
  console.log('\nOld-format remaining after cleanup: ' + still.length);
  still.forEach((p) => console.log('  ' + p.paymentNumber));
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
