# Share an existing Postgres instance in v1

The v1 service keeps its data in its own database, with its own login role, on a Postgres instance the maintainer already runs for other products. It does not get an instance of its own. The v1 beta is free and has no billing, so a dedicated instance would be a standing cost before anyone uses the product. Sharing follows a setup already proven in production.

## Consequences

- The role has no grants outside the `testnotary` database. An administrator of the shared instance can still read Testnotary's data.
- An outage of the shared instance makes verification unavailable. The action treats an unreachable service as "run the tests", so CI never skips on a guess.
- The code needs only a `DATABASE_URL`, so a move to another instance is a data migration, not a code change.
- The instance identifier, the endpoint and the account details live only in Terraform variables that are never committed.

## Amendment, 2026-11-15: conditions for sharing, and when to move

A separate role isolates nothing while another app on the instance connects as the master user, because the master can reach every database. When this ADR was written, the other product connected as the master user, and the instance accepted connections from the whole internet. So Testnotary launches on the shared instance only when all four of these hold. Otherwise it gets an instance of its own before launch.

1. No app connects as the master user. Each product has its own owner role, and RDS manages and rotates the master password, which no app reads.
2. None of Testnotary's roles (app, retention, migration) is `rds_superuser`. Each can connect only to the `testnotary` database, and `PUBLIC` cannot connect to either product's database.
3. Terraform state for the instance lives in an encrypted remote backend, not on a laptop.
4. Postgres is not reachable from the internet. Apps reach it through VPC connectors, and migrations run from CI or through a bastion session, not from a laptop's address.

Testnotary moves to an instance of its own before the beta ends, or sooner at the first of these:

- a security incident in either product
- 25 repos in enforce mode
- the shared instance's CPU or connections above 70% for a day
- a security review that asks for it
