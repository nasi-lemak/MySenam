# ADR 0007: Who owes stored credit

- **Status:** current.
- **Context:** stored credit is money a customer has paid and not yet spent;
  whoever can be asked to honour it owes it.
- **Decision:** `MYSENAM_CREDIT_SCOPE` (`src/lib/mode.ts`): `platform` — credit
  spendable at any venue, owed by the install (right for one business's own
  install) — or `venue` — spendable only where bought (the marketplace
  default). On a marketplace, credit, passes and memberships bought at one
  branch of a business work at all its branches and are owed by the business.
  Credit bought before an install switched to `venue` stays spendable
  anywhere, so no balance shrinks.
- **Rationale:** a platform holding money that strangers paid to other
  businesses is a payments business.
- **Consequences:** reports show credit as a liability of the venue or
  business that owes it; the accounting export marks credit and vouchers as
  not takings until spent ([reporting](../../features/reporting.md)).
