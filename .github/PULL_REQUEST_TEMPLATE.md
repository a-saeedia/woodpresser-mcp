## What changed

<!-- One paragraph. The why matters more than the diff. -->

## Which mode / surface

- [ ] `core` (REST)
- [ ] `php` (bridge: PHP, SQL, fs, snippets)
- [ ] `elementor`
- [ ] CLI / install
- [ ] bridge plugin
- [ ] docs only

## Verification

- [ ] `npm run build`
- [ ] `npm test`
- [ ] `npm run verify:package`
- [ ] `npm run test:integration` (required for anything touching the bridge or a handler)

Paste the counts:

```
tests X passed, 0 failed
integration X passed, 0 failed
```

## Safety

- [ ] No new tool changes state without a `confirm` literal
- [ ] New bridge routes have a `permission_callback`
- [ ] No secrets in code, tests or fixtures
- [ ] `CHANGELOG.md` updated under `[Unreleased]`
