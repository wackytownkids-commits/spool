# Releasing Spool

Three-line shipping process. Same as Cook Up.

## 1. Bump the version
Edit `package.json`'s `version` field. Use semver:
- Patch (1.0.0 → 1.0.1): bug fix
- Minor (1.0.0 → 1.1.0): new feature, no breaking changes
- Major (1.0.0 → 2.0.0): breaking change

## 2. Build the installer
```
npm run dist:win
```
Output: `dist/Spool-Setup-X.Y.Z.exe`, `dist/Spool-Setup-X.Y.Z.exe.blockmap`, `dist/latest.yml`.

## 3. Cut the GitHub release
Create a new release at `https://github.com/wackytownkids-commits/spool/releases/new`:
- Tag: `vX.Y.Z` (must match `package.json` version, with leading `v`)
- Title: `Spool X.Y.Z`
- Notes: short changelog
- Upload: `Spool-Setup-X.Y.Z.exe`, `Spool-Setup-X.Y.Z.exe.blockmap`, `latest.yml`
- Publish.

Existing installs auto-update on next launch (electron-updater polls GitHub releases).

---

## First-time release (v1.0.0)

The repo doesn't exist yet. Cory needs to:

1. Create the public GitHub repo: `wackytownkids-commits/spool`
2. Send the URL.
3. I'll push the source and cut v1.0.0 with the already-built `dist/Spool-Setup-1.0.0.exe`.

If the repo name differs, update `build.publish.repo` in `package.json` first.
