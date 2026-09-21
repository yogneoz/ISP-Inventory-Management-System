// Root shim — the real app now lives in server/src/app.ts (createApp) and
// server/index.ts (bootstrap/listen). Kept so legacy entry points keep working.
export * from './server/src/app';
