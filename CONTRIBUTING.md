# Contributing

Snapwing (working title) is in active development and not installable yet. The code changes many times a day, built by AI agents working from written specs, with one human maintainer.

## Issues are welcome now

- **Bugs:** use the bug report form. Point at a file, a command or a doc section if you can.
- **Questions and ideas:** open an issue. Design questions are useful even before there is code to run.
- **Security problems:** report them privately (see [SECURITY.md](SECURITY.md)), never in a public issue.

## Pull requests from outside contributors open after v2.0

Until v2.0, the code moves too fast for an outside pull request to land cleanly, so they are not being accepted yet. If you have a fix in mind, describe it in an issue; it may become a task. This section will change when outside pull requests open.

## How the work is organized

- Every task is an issue with the spec sections it implements, the files it may touch (`touches:`), what must merge first (`blockedBy:`), and acceptance checkboxes.
- The spec is [docs/SPEC.md](docs/SPEC.md), with an index in [docs/INDEX.md](docs/INDEX.md).
- A pull request closes one issue, adds the tests its `tier:*` labels ask for, and is squash-merged when CI is green.
- Comments written by agents start with `:robot:` and say which agent wrote them.

## House rules

- Never commit a secret, a token or a private message, in any file. CI runs gitleaks on every change.
- No em dashes in prose (`pnpm lint:prose`).
- Tests run on SQLite and Postgres.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
