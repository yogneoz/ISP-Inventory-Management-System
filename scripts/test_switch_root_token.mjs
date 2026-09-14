// Quick sanity test for the session-root token logic used by
// /api/auth/switch-profile. Replicates issueAuthToken + verifyAuthToken +
// the session-root resolution to validate the "switch back to root" flow.
import crypto from 'node:crypto';

const AUTH_TOKEN_SECRET = 'test-secret';
const AUTH_TOKEN_TTL_SECONDS = 3600;

function issueAuthToken(user, sessionRoot) {
  const root = sessionRoot && sessionRoot.id && sessionRoot.id !== user.id ? sessionRoot : null;
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    branchId: user.branchId || '',
    allowedBranchIds: user.allowedBranchIds || [],
    canSwitchUser: Boolean(user.canSwitchUser),
    rootId: root?.id || '',
    rootEmail: root?.email || '',
    rootCanSwitchUser: Boolean(root?.canSwitchUser),
    rootRole: root?.role || '',
    exp: Math.floor(Date.now() / 1000) + AUTH_TOKEN_TTL_SECONDS,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyAuthToken(token) {
  const [payload, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return {
      id: parsed.sub,
      email: parsed.email,
      name: parsed.name || '',
      role: parsed.role,
      branchId: parsed.branchId || '',
      allowedBranchIds: Array.isArray(parsed.allowedBranchIds) ? parsed.allowedBranchIds : [],
      canSwitchUser: Boolean(parsed.canSwitchUser),
      rootId: parsed.rootId || '',
      rootEmail: parsed.rootEmail || '',
      rootCanSwitchUser: Boolean(parsed.rootCanSwitchUser),
      rootRole: parsed.rootRole || '',
    };
  } catch (_err) {
    return null;
  }
}

// Simulates the authorization gate in the switch-profile endpoint.
function canSwitch(activeUser) {
  const isActiveSuperAdmin = activeUser.role === 'SUPER_ADMIN';
  const rootAllowed = Boolean(activeUser.rootId) && (Boolean(activeUser.rootCanSwitchUser) || activeUser.rootRole === 'SUPER_ADMIN');
  return activeUser.canSwitchUser || isActiveSuperAdmin || rootAllowed;
}

// Simulates the session-root resolution block in the switch-profile endpoint.
function resolveSessionRoot(previousUser, user) {
  const rootId = previousUser?.rootId || '';
  const rootEmail = previousUser?.rootEmail || '';
  const targetIsRoot = Boolean(rootId) && (user.id === rootId || (rootEmail && user.email?.toLowerCase() === rootEmail.toLowerCase()));
  return targetIsRoot
    ? null
    : rootId
      ? { id: rootId, email: rootEmail, canSwitchUser: previousUser?.rootCanSwitchUser, role: previousUser?.rootRole }
      : previousUser?.id && previousUser.id !== user.id
        ? { id: previousUser.id, email: previousUser.email, canSwitchUser: previousUser.canSwitchUser, role: previousUser.role }
        : null;
}

const superAdmin = { id: 'usr-sa', email: 'superadmin@example.com', name: 'Super Admin', role: 'SUPER_ADMIN', branchId: 'WH001', canSwitchUser: true };
const branchMgr = { id: 'usr-bm', email: 'branch1@example.com', name: 'Branch 1', role: 'BRANCH_MANAGER', branchId: 'WH001', canSwitchUser: false };
const accountant = { id: 'usr-ac', email: 'acct@example.com', name: 'Accountant', role: 'ACCOUNTANT', branchId: 'WH001', canSwitchUser: false };

let failures = 0;
const assert = (cond, label) => {
  if (cond) console.log(`  PASS: ${label}`);
  else { console.error(`  FAIL: ${label}`); failures++; }
};

console.log('1. Super Admin login token (no root marker):');
const rootToken = issueAuthToken(superAdmin);
const rootAuth = verifyAuthToken(rootToken);
assert(rootAuth.role === 'SUPER_ADMIN' && rootAuth.rootId === '', 'root token has empty root marker');
assert(canSwitch(rootAuth) === true, 'root can switch (canSwitchUser=true)');

console.log('2. First hop: Super Admin -> Branch Manager:');
{
  // active (Super Admin) switch to branch manager
  const sessionRoot = resolveSessionRoot(null, branchMgr); // previousUser (root) has no marker, but previousUser.id !== target
  // In reality previousUser is the root user itself; simulate:
  const sessionRoot2 = resolveSessionRoot(superAdmin, branchMgr);
  assert(sessionRoot2?.id === 'usr-sa', 'branch manager token carries root id');
  const bmToken = issueAuthToken(branchMgr, sessionRoot2);
  const bmAuth = verifyAuthToken(bmToken);
  assert(bmAuth.canSwitchUser === false, 'branch manager has no own switch flag');
  assert(canSwitch(bmAuth) === true, 'branch manager can switch back via root marker');
  assert(bmAuth.rootId === 'usr-sa' && bmAuth.rootRole === 'SUPER_ADMIN', 'root marker preserved on child token');
}

console.log('3. Switch back: Branch Manager -> Super Admin:');
{
  const bmAuth = { id: 'usr-bm', email: 'branch1@example.com', role: 'BRANCH_MANAGER', canSwitchUser: false, rootId: 'usr-sa', rootEmail: 'superadmin@example.com', rootCanSwitchUser: true, rootRole: 'SUPER_ADMIN' };
  const backToken = issueAuthToken(superAdmin, resolveSessionRoot(bmAuth, superAdmin));
  const backAuth = verifyAuthToken(backToken);
  assert(backAuth.role === 'SUPER_ADMIN' && backAuth.rootId === '', 'switched-back root token has no root marker (fresh session)');
  assert(canSwitch(backAuth) === true, 'restored root can switch again');
}

console.log('4. Multi-hop: Super Admin -> BM -> Accountant -> back to Super Admin:');
{
  // hop 1: SA -> BM (root marker set)
  const hop1 = issueAuthToken(branchMgr, resolveSessionRoot(superAdmin, branchMgr));
  const hop1Auth = verifyAuthToken(hop1);
  // hop 2: BM -> Accountant (carry root marker)
  const hop2 = issueAuthToken(accountant, resolveSessionRoot(hop1Auth, accountant));
  const hop2Auth = verifyAuthToken(hop2);
  assert(hop2Auth.rootId === 'usr-sa' && hop2Auth.rootRole === 'SUPER_ADMIN', 'root marker survives 2nd hop');
  assert(canSwitch(hop2Auth) === true, 'accountant can switch back via root marker');
  // hop 3: Accountant -> SA (collapse)
  const hop3 = issueAuthToken(superAdmin, resolveSessionRoot(hop2Auth, superAdmin));
  const hop3Auth = verifyAuthToken(hop3);
  assert(hop3Auth.role === 'SUPER_ADMIN' && hop3Auth.rootId === '', 'switch-back collapses root marker');
}

console.log('5. Non-privileged fresh login cannot switch:');
{
  const bmFresh = verifyAuthToken(issueAuthToken(branchMgr)); // fresh branch manager login, no root
  assert(canSwitch(bmFresh) === false, 'fresh branch manager cannot switch');
}

console.log('6. Old (pre-fix) switched token without root marker -> switch-back rejected:');
{
  const stale = verifyAuthToken(issueAuthToken(branchMgr)); // no root fields (old format)
  assert(canSwitch(stale) === false, 'stale token rejected (cannot switch)');
}

console.log('');
if (failures === 0) console.log('ALL TESTS PASSED ✔');
else { console.error(`${failures} TEST(S) FAILED ✘`); process.exit(1); }