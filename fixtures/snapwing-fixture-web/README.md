# snapwing-fixture-web

This repository is a temporary test fixture for the Snapwing build. It is deleted when the build is done
(`pnpm github:bootstrap destroy --yes`). Nothing here is a real project.

Fixture repository for Snapwing's live and e2e tests. Do not fix the seeded bug on `main` by hand:
`pnpm github:bootstrap fixture` (in the snapwing repository) resets this repository to its seeded
state, with `main` protected (required check `snapwing/review` plus one approval).

The seeded bug: `applyDiscount` in `src/cart.ts` takes off a tenth of the discount it should.
`test/cart.test.ts` fails until it is fixed.
