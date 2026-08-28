# Continuous Integration

## Enable GitHub Actions

The sandbox GitHub App cannot push files under `.github/workflows/`. To enable CI:

```bash
mkdir -p .github/workflows
cp docs/github-actions-ci.yml .github/workflows/ci.yml
git add .github/workflows/ci.yml
git commit -m "ci: enable GitHub Actions lint/test/build"
git push
```

The workflow runs on Node 20:

1. `npm ci`
2. `npm run lint` (TypeScript)
3. `npm test` (Vitest — offline backends)
4. `npm run build`

## Local

```bash
npm test
npm run lint
npm run build
```
