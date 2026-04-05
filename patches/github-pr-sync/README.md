# GitHub PR Sync Native JS Bundle

This directory contains an external native-JS bundle for the GitHub PR -> Paperclip control-plane integration.

## Contents
- `manifest.json` — declarative file mapping and base-hash guardrails
- `assets/` — the implementation payload as native source files
- `apply.mjs` — JS-native patch apply helper
- `verify.mjs` — JS-native verification entrypoint
- `smoke.mjs` — JS-native local/isolated E2E smoke verification after apply
- `e2e-smoke.sh` — shell smoke helper kept for compatibility
- `deploy-supportopia-remote.mjs` — JS-native wrapper for the Supportopia remote helper
- `supportopia-remote-pr-ops.sh` — Supportopia-specific remote helper/doc sync script

## Intended workflow
This bundle is for environments where you want to keep the upstream Paperclip codebase untouched and apply the feature as an external customization layer.

### Apply
```bash
node patches/github-pr-sync/apply.mjs /path/to/paperclip-checkout
```

### Verify
```bash
node patches/github-pr-sync/verify.mjs /path/to/paperclip-checkout
```

### Remote helper sync
```bash
node patches/github-pr-sync/deploy-supportopia-remote.mjs root@187.124.171.224
```

## Notes
- The `assets/` directory now contains the real implementation, tests, docs, and bridge scripts.
- `apply.mjs` copies those assets into a clean checkout, with base-hash checks for replaced upstream files.
- `verify.mjs` assumes the bundle has already been applied and then runs targeted tests plus the smoke flow.
- `supportopia-remote-pr-ops.sh` is environment-specific to the current Supportopia VPS layout.
