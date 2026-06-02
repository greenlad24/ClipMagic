# Lab — parallel product-improver app

A **fully separate copy** of ClipMagic that the `product-improver` agent works
in. It is isolated from the main app on every axis that matters:

| | Main app | Lab app |
|---|---|---|
| Code | `src/`, `server/`, `web/` (repo root) | `lab/src`, `lab/server`, `lab/web` |
| Port | `8080` | `9090` |
| Data (db, uploads, outputs) | `data/` | `lab/data/` |

The agent only ever edits files under `lab/`, so its experiments can never
interfere with your work or your data.

## Run it

```bash
bash lab/run-lab.sh            # build + serve on http://localhost:9090
bash lab/run-lab.sh --no-build # fast restart (skip rebuild)
PORT=9999 bash lab/run-lab.sh  # override the port
```

Dependencies are **shared** from the main app via symlinks (`lab/server/node_modules`
→ `../server/node_modules`, `lab/web/node_modules` → `../web/node_modules`) — same
library versions, no reinstall, and read-only so there's no interference. Only
the code, data, and port are isolated. The symlinks, builds (`*/dist`), and
`lab/data/` are git-ignored; the script recreates the symlinks each run, which
also makes this work after a fresh clone in an ephemeral web session.

## Promoting a lab change into the main app

Because the lab is a literal copy, improvements don't auto-merge. To bring one
over, diff the file and apply it to the matching root path, e.g.:

```bash
diff -u src/pages/CutterPage.tsx lab/src/pages/CutterPage.tsx
```

Then port the wanted hunks into the root file and rebuild the main app.
