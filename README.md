# Seelen Workspace Taskbar

A proof-of-concept Seelen UI widget with taskbar state scoped to the active Seelen workspace.

## What it does

- Creates one bottom taskbar per monitor.
- Shows only windows belonging to that monitor's active Seelen workspace.
- Includes windows pinned globally by Seelen.
- Stores app pins independently for each monitor and workspace.
- Shows application icons with app names on hover.
- Supports Never, Always, and On overlap auto-hide modes, configurable per monitor.
- Supports Minimal and Full Width modes, configurable per monitor.
- Uses a layered hitbox, so hidden and transparent areas do not block windows underneath.
- Hides the native Windows taskbar while enabled and restores the previous SeelenWeg state when disabled.
- Left-clicks focus/minimize a running app or launch a pinned app.
- Right-clicks a running app to pin it, or a pinned app to unpin it, on the current workspace.

If an icon has not been cached yet, the widget asks Seelen to extract it and temporarily shows a letter tile. The taskbar is an overlay and does not reserve screen space.

## Build

The authored widget code is TypeScript in `src/index.ts`. Builds are strictly type-checked, then bundled to loadable JavaScript in `dist/widget/index.js`.

```powershell
npm install
npm run build
```

## Load for development

Keep Seelen UI running, then run:

```powershell
slu resource load widget .\dist\widget
```

In Seelen Settings, enable **Workspace Taskbar**. The widget uses SeelenWeg's service-managed native-taskbar ownership while suppressing SeelenWeg's visual instances. Loaded development resources are session-only and must be loaded again after restarting Seelen UI.

To unload it:

```powershell
slu resource unload widget .\dist\widget
```

To rebuild the widget and create a distributable YAML file under `dist/bundles/`:

```powershell
npm run bundle
```

Bundling requires the Seelen CLI. Set `SLU_PATH` to override its executable path
(the default on Windows is `C:\Program Files\Seelen\Seelen UI\slu.exe`).

## Releases

CI type-checks and bundles the widget on pull requests and pushes to `main`.
It then runs semantic-release, which skips publishing on pull requests and
publishes qualifying releases on `main`.
It creates a version tag and GitHub release with generated release notes and a
`workspace-taskbar-<version>.yml` download. The release workflow extracts the
Seelen CLI from its official Windows package and authenticates with a GitHub App.
Configure the `SEMANTIC_RELEASE_APP_ID` repository variable and
`SEMANTIC_RELEASE_PRIVATE_KEY` secret. The app needs repository contents, issues,
and pull requests write permissions, plus permission to push release commits to
`main` under any branch protection rules. Releases are GitHub-only.

Use [Conventional Commits](https://www.conventionalcommits.org) for release changes.
Releases synchronize the version in `package.json` and `package-lock.json` using
`semantic-release-mirror-version` and commit both files with `@semantic-release/git`.
The CI workflow can also be run manually on `main` to retry a failed release.

## License

Copyright (C) 2026 dvirtz.

This project is licensed under the [GNU Affero General Public License v3.0 only](LICENSE).
It uses [`@seelen-ui/lib`](https://www.npmjs.com/package/@seelen-ui/lib), which is also distributed under the GNU Affero General Public License v3.0. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution.
