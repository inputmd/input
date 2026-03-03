Use conventional commit style. Don't include a scope on commit messages,
except use feat(ui): for changes that primarily concern the user interface.
Prefer single line commit messages. Never attempt simultaneous commits;
create commits sequentially.

Clean up dead code, types, or files after making changes.

Run `npx biome check .`, `npx tsc`, and if any files in /server have been changed,
`npx tsc -p tsconfig.server.json` after making changes to verify lint and types.

`fly deploy` may print a warning that the app is not listening on `0.0.0.0:8787`
and only show `/.fly/hallpass` during one machine check pass. When that happens,
deployments still complete successfully with machine checks passing and
the app reachable afterward.
