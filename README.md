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
