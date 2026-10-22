# ADR 0005: One codebase as a shared marketplace or a business's own install

- **Status:** current.
- **Context:** independent venues want to be found on a shared marketplace;
  some businesses want their own branded site with their own customers and
  data.
- **Decision:** the same code runs as the marketplace
  (`MYSENAM_MARKETPLACE=on`: self-service sign-up, monthly venue invoices,
  credit per venue) or as one business's install with its own database.
  Inside one install, tenancy is by venue and business, enforced on every
  admin route ([tenancy](../tenancy.md)). Storefront domains give a business
  its own look on the marketplace without separating data.
- **Rationale:** one codebase to maintain; a business needing hard separation
  gets a separate database rather than row-level separation inside a shared
  one.
- **Consequences:** customer accounts belong to the install, not to a venue;
  a storefront is a window onto part of the marketplace, not a wall around a
  business's data.
- **Known limitations:** there is no database-level row security; isolation
  inside an install depends on every route checking scope, which
  `tests/routes.test.ts` and the role tests check.
