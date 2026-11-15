# Share an existing Postgres instance in v1

The v1 service keeps its data in its own database, with its own login role, on a Postgres instance the maintainer already runs for other products. It does not get an instance of its own. The v1 beta is free and has no billing, so a dedicated instance would be a standing cost before anyone uses the product. Sharing follows a setup already proven in production.

## Consequences

- The role has no grants outside the `testnotary` database. An administrator of the shared instance can still read Testnotary's data.
- An outage of the shared instance makes verification unavailable. The action treats an unreachable service as "run the tests", so CI never skips on a guess.
- Testnotary moves to an instance of its own before the beta ends, or sooner if load or a security review calls for it. The code needs only a `DATABASE_URL`, so the move is a data migration, not a code change.
- The instance identifier, the endpoint and the account details live only in Terraform variables that are never committed.
