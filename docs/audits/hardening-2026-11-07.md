# Post-audit hardening round, 7 November 2026

A bounded round on the [business-process audit](findings-register-2026-11-06.md): verified
defects and decisions the owner authorised in writing, nothing else. It is not another
audit and not a feature round. The sections below are filled as the round proceeds; the
round is not finished until its [release record](../development/testing.md#release-records)
says so.

## 1. Baseline

| Item | Value |
| ---- | ----- |
| Branch | `claude/sports-court-booking-w99x22` |
| Commit at the start | `068b9aa` (a release-record commit; its only change over `1737cc2` is `docs/development/testing.md`) |
| Last verified source | `1737cc2`, source digest `8cb908af668344991b9caba969d31b98f6b00418e96e83f03d72370ec902be77` (`node scripts/verify.mjs check` reported VERIFIED, one record-only commit since) |
| Working tree at the start | clean |
| Last release verification | PASS on `1737cc2`, 6 November 2026, on the AI VM: PGlite 6472 passed and 13 expected skips; Postgres 16 6485 of 6485; end-to-end 12 of 12; acceptance scenarios 95 of 95; type check, lint, documentation checks and a fresh production build passed. A historical result, not a statement about any later commit. |
| Audit baseline and fix round | audit baseline `2aabdd4`; fix round ended at `126d7d0` |

The audit's 140 finding identifiers (several describe one root cause) stood, at the start,
at 77 fixed, 10 partly fixed, 20 waiting for a decision and 33 open
([known limitations](../roadmap/known-limitations.md#business-process-audit-6-november-2026-open-items)).

### Selected for this round (with the owner's authority)

Security: A13, A14, A10 (DEC-05), A15, D24, E2, A8. Payments: C19, C18 (DEC-14), G19,
G17, C2 (memo, guard and test only), G15, D16, D17, C11, D1, C10, C6, C13 (documented, not
changed). Rules: B9 = E10 (DEC-11), B12 (DEC-09), B14, B11, D6 (DEC-34), B16 = C12 = D15
(DEC-16), C5, F6 (DEC-50), E18 (DEC-45). Smaller: B15, B6, D18, D19, E16, E17, D11/G16,
G18.

### Deferred on purpose

A5 = H8 exit workflow (restricted-pilot operating policy instead), E11, E19, D8, D9, D10,
D22, DEC-23 (voucher expiry, desk redemption: a lawyer), tournament and league
conveniences that corrupt no data, new youth messaging or moderation, new markets or
providers, unstaffed smart-lock access.

### Needs the owner, a tax adviser or a lawyer (not decided in code)

C2/DEC-19 (tax adviser), DEC-23 (lawyer), DEC-39 phone number as identity (owner), DEC-02
validity pausing during suspension (owner), the venue-exit design (A5), youth messaging
(a Malaysian lawyer, `docs/operations/legal-review-youth-messaging.md`).
