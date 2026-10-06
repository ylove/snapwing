# Security

Snapwing (working title) is in active development and not installable yet. There is no supported release.

## Reporting a vulnerability

Please report security problems privately through GitHub: **Security**, then **Report a vulnerability**, or [open a private advisory](https://github.com/ylove/snapwing/security/advisories/new). Don't open a public issue.

Include what you found, where (a file and line, or a commit), and how to reproduce it. You'll get a reply as soon as the maintainer can; there is no formal response time yet.

## Scope

- The code in this repository, including how untrusted code (the coding agent's work) is isolated.

## Secrets

No secret is ever committed to this repository, and CI scans every change with gitleaks. If you find something that looks like a real credential, report it privately as above.
