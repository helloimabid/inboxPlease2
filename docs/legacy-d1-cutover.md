# Retired legacy D1 note

This document is retained only to explain the database replacement boundary.

The deployment owner deleted the incompatible legacy D1 named `inboxplease` on
2026-07-19 and then authorized creation of a fresh database with the same name. No legacy
rows were imported or copied by this repository.

The replacement was created in the APAC location, bound as `DB`, migrated through
`0009_authjs_drizzle.sql`, and was audited as ready for that schema revision with no
foreign-key violations. The old in-place conversion and staged cutover plan is therefore
retired. The newer `0010_facebook_page_onboarding.sql` is pending separate remote
approval, so the current audit correctly reports `schema=v2-partial` and the schema gate
is closed.

Future schema changes must use reviewed, sequential Wrangler migrations. If the binding
changes or the remote audit stops reporting `v2-ready`, set `D1_SCHEMA_READY=false`
before deployment or background processing.
