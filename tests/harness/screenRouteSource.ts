/**
 * The source of the screen route table.
 *
 * A4 declared the table in App.tsx; the module move put the same
 * `screenRoute(key, element)` entries in routes/screenRoutes.tsx. Guards that
 * pin one entry per tab read this module, so a guard still fails when an entry,
 * its element or its props change — it just no longer cares which file the
 * table sits in.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SCREEN_ROUTES_FILE = 'client/src/routes/screenRoutes.tsx';

export const readScreenRoutes = (): string =>
  fs.readFileSync(path.resolve(process.cwd(), SCREEN_ROUTES_FILE), 'utf8');
