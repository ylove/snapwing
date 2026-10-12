# web

Fixture storefront for the multi-repo contract tests: a copy of the single-repo web fixture's cart that
shows prices through `@fixture/shared-ui`.

`package.json` pins shared-ui by commit (`git+file://<repository>#<commit>`). `npm test` first runs
`scripts/resolve-shared-ui.mjs`, which checks that exact commit out of the local repository into
`node_modules`, so the suite needs no network and no package manager install.

The seeded bug: a euro cart shows prices with a dollar sign. shared-ui's `formatPrice` has no currency
yet; the fix takes both repositories: shared-ui gains `formatPrice(cents, currency)`, then web bumps its
pin to that commit and passes `cart.currency`.
