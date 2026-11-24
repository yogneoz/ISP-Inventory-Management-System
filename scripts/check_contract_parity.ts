/**
 * Contract parity guard for the two externally-consumed surfaces.
 *
 *   /api/v1/*        — the PulseHR mobile app  -> docs/contracts/mobile-v1.md
 *   /api/partner/v1/* — the subscription portal -> docs/contracts/partner-v1.md
 *
 * It fails the build in three cases:
 *
 *   1. a route is registered in `server/src/routes/*.routes.ts` but is missing
 *      from the contract document (undocumented surface);
 *   2. the document names a route that is no longer registered (stale promise);
 *   3. a documented request/response field no longer appears anywhere in the
 *      controller or service that produces it (silent rename or removal).
 *
 * It is deliberately source-level rather than runtime: it must run in the static
 * CI job, with no database, and it catches drift at the moment it is introduced.
 * Its limit is honest and documented in the docs themselves: it proves a field
 * name still exists in the implementation, not that its type or meaning is
 * unchanged — that is what the API tests and the fixture are for.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

type Surface = {
  label: string;
  routesFile: string;
  docFile: string;
  corpus: string[];
  /** Route prefixes that this surface owns. */
  prefixes: string[];
};

const SURFACES: Surface[] = [
  {
    label: 'mobile',
    routesFile: 'server/src/routes/mobile.routes.ts',
    docFile: 'docs/contracts/mobile-v1.md',
    corpus: [
      'server/src/controllers/mobile.controller.ts',
      'server/src/services/mobile.service.ts',
      // The approvals inbox is its own service and the profile projections are
      // SELECT lists in the repo, so both are part of what the app consumes.
      'server/src/services/approvalInbox.service.ts',
      'server/src/models/approvalInbox.repo.ts',
      'server/src/models/hrSelfService.repo.ts',
      // The re-auth header the sensitive reads require is declared here.
      'server/src/middleware/sensitiveAuth.ts',
    ],
    prefixes: ['/api/v1/'],
  },
  {
    label: 'partner',
    routesFile: 'server/src/routes/partner.routes.ts',
    docFile: 'docs/contracts/partner-v1.md',
    corpus: [
      'server/src/controllers/partner.controller.ts',
      'server/src/services/integration.service.ts',
      'server/src/services/serviceInvoicePosting.service.ts',
      // The admin read views are shaped by the SELECT lists in the repo, so a
      // renamed column there is a contract change for the portal's console.
      'server/src/models/integration.repo.ts',
    ],
    prefixes: ['/api/partner/v1/', '/api/admin/integration/'],
  },
];

const ROUTE_RE = /\bapp\.(get|post|patch|put|delete)\(\s*'([^']+)'/g;

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function registeredRoutes(file: string): string[] {
  const source = read(file);
  const found: string[] = [];
  for (const match of source.matchAll(ROUTE_RE)) {
    found.push(`${match[1].toUpperCase()} ${match[2]}`);
  }
  return found;
}

type DocRoute = { route: string; req: string[]; res: string[] };

function documentedRoutes(docFile: string): DocRoute[] {
  const source = read(docFile);
  const fence = source.match(/```contract\r?\n([\s\S]*?)```/);
  if (!fence) throw new Error(`${docFile}: no \`\`\`contract block found`);

  const routes: DocRoute[] = [];
  for (const raw of fence[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [route, ...parts] = line.split('|').map((part) => part.trim());
    if (!/^(GET|POST|PUT|PATCH|DELETE) \//.test(route)) {
      throw new Error(`${docFile}: cannot parse contract line "${raw}"`);
    }
    const fieldList = (prefix: string): string[] => {
      const part = parts.find((candidate) => candidate.startsWith(prefix));
      if (!part) return [];
      return part
        .slice(prefix.length)
        .split(',')
        .map((field) => field.trim())
        .filter(Boolean)
        .filter((field) => !field.startsWith('@'));
    };
    routes.push({ route, req: fieldList('req:'), res: fieldList('res:') });
  }
  return routes;
}

function ownsRoute(surface: Surface, route: string): boolean {
  const path = route.split(' ')[1];
  return surface.prefixes.some((prefix) => path.startsWith(prefix));
}

let failures = 0;
const fail = (message: string): void => {
  failures += 1;
  console.error(`✖ ${message}`);
};

for (const surface of SURFACES) {
  const registered = registeredRoutes(surface.routesFile).filter((route) =>
    ownsRoute(surface, route)
  );
  const documented = documentedRoutes(surface.docFile);
  const corpus = surface.corpus.map(read).join('\n');

  const registeredSet = new Set(registered);
  const documentedSet = new Set(documented.map((entry) => entry.route));

  for (const route of registeredSet) {
    if (!documentedSet.has(route)) {
      fail(
        `${surface.label}: ${route} is registered in ${surface.routesFile} but not documented in ${surface.docFile}`
      );
    }
  }
  for (const route of documentedSet) {
    if (!registeredSet.has(route)) {
      fail(
        `${surface.label}: ${surface.docFile} documents ${route}, but ${surface.routesFile} no longer registers it`
      );
    }
  }

  for (const entry of documented) {
    for (const field of [...entry.req, ...entry.res]) {
      if (!new RegExp(`\\b${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(corpus)) {
        fail(
          `${surface.label}: ${entry.route} documents "${field}", which no longer appears in ${surface.corpus.join(' or ')}`
        );
      }
    }
  }

  if (registeredSet.size > 0 || documentedSet.size > 0) {
    console.log(
      `${surface.label}: ${registeredSet.size} route(s) registered, ${documentedSet.size} documented`
    );
  }
}

if (failures > 0) {
  console.error(`\ncontract parity: ${failures} drift failure(s).`);
  process.exit(1);
}

console.log('contract parity: mobile and partner contracts match their code.');
