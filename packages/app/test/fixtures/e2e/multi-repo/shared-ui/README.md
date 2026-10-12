# shared-ui

Fixture library for the multi-repo contract tests. The consumer is the `web` fixture, which pins this
library by commit in its `package.json`.

The seeded gap: `formatPrice(cents)` has no currency, so every price is shown with a dollar sign. The
fix is a contract change (`formatPrice(cents, currency)`), and the consumer then has to pass its cart's
currency.
