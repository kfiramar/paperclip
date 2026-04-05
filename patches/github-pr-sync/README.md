# GitHub PR Sync Native JS Bundle

This directory contains an external native-JS bundle for the GitHub PR -> Paperclip control-plane integration.

## Contents
- `manifest.json` — declarative file mapping and base-hash guardrails
- `assets/` — the implementation payload as native source files
- `apply.mjs` — JS-native patch apply helper
- `verify.mjs` — JS-native verification entrypoint
- `smoke.mjs` — JS-native local/isolated E2E smoke verification after apply
- `e2e-smoke.sh` — shell smoke helper kept for compatibility
- `Dockerfile.hostinger-overlay` — Docker overlay recipe using Hostinger's image as the base
- `build-hostinger-overlay.mjs` — generates an overlay build context and can build the derived image
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

### Build a Hostinger-base overlay image
```bash
node patches/github-pr-sync/build-hostinger-overlay.mjs /path/to/clean-paperclip-checkout --image paperclipai-patched:github-pr-sync-overlay
```

To generate the Docker build context without running `docker build` immediately:

```bash
node patches/github-pr-sync/build-hostinger-overlay.mjs /path/to/clean-paperclip-checkout --out-dir /tmp/paperclip-overlay --skip-docker-build
```

## Automatic verification

This branch now includes a GitHub Actions workflow:

- `.github/workflows/github-pr-sync-bundle.yml`

It automatically:
1. checks out the branch
2. creates a clean worktree from the bundle's pinned base commit
3. runs `apply.mjs` against that clean tree
4. runs `verify.mjs` against that clean tree

So pushes to the bundle branch and manual workflow dispatches will re-validate the native JS bundle automatically.

## Notes
- The `assets/` directory now contains the real implementation, tests, docs, and bridge scripts.
- `apply.mjs` copies those assets into a clean checkout, with base-hash checks for replaced upstream files.
- `manifest.json` pins the expected upstream base commit for the bundle.
- `verify.mjs` assumes the bundle has already been applied and then runs targeted tests plus the smoke flow.
- `build-hostinger-overlay.mjs` applies the bundle to a clean checkout, builds Paperclip there, and prepares a minimal overlay image on top of `ghcr.io/hostinger/hvps-paperclip:latest`.
- `supportopia-remote-pr-ops.sh` is environment-specific to the current Supportopia VPS layout.
