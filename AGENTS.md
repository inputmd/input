Use conventional commit style, e.g. start repos with "fix:" for fixes,
"feat:" for feature improvements. Don't include a scope on commit
messages, except use feat(ui): for changes that primarily concern the
user interface. Prefer single line commit messages. Never attempt
multiple git actions at the same time. If 'git add' and 'git commit'
are both necessary, run git add first, followed by git commit,
sequentially.

Clean up dead code, types, or files after making changes.

Run `npx biome check .`, `npx tsc`, and if any files in /server have
been changed, `npx tsc -p tsconfig.server.json` after making changes
to verify lint and types. To run tests, use `npx ava`.

`fly deploy` may print a warning that the app is not listening on
`0.0.0.0:8787` and only show `/.fly/hallpass` during one machine check
pass. When that happens, deployments still complete successfully with
machine checks passing and the app reachable afterward.
