# The secrets, as empty Secrets Manager entries. Terraform never holds a value: the maintainer puts
# each one by hand (runbook), so no secret reaches the state or the repo.
#
# Each service secret reaches the server as an environment variable holding
# `secretsmanager:<arn>`, which the server resolves when it starts (apps/web/src/server/secrets.ts).
# The environment variable names are the ones `configFromEnv` reads; a new secret setting is one
# more entry in `service_secrets`.

locals {
  # Variables `configFromEnv` reads today: DATABASE_URL, GITHUB_WEBHOOK_SECRET, GITHUB_APP_PRIVATE_KEY,
  # GITHUB_APP_CLIENT_SECRET and BETTER_AUTH_SECRET (browser sign-in, T-813). The others are the
  # spec's remaining secrets, named ahead of the tickets that add them to `ServiceConfig`; rename
  # an entry here if that ticket picks another variable name.
  service_secrets = {
    DATABASE_URL             = "database-url" # postgres://testnotary_app:…@…/testnotary
    GITHUB_WEBHOOK_SECRET    = "github-app-webhook-secret"
    GITHUB_APP_PRIVATE_KEY   = "github-app-private-key" # PEM
    GITHUB_APP_CLIENT_SECRET = "github-app-client-secret"
    AUDIT_MASTER_KEY         = "audit-master-key"
    BETTER_AUTH_SECRET       = "better-auth-secret"
  }

  # Read by the one-off jobs only, through ECS's own secret injection; the service never can.
  job_secrets = {
    migration = "database-migration-url" # postgres://testnotary_migration:…@…/testnotary
    retention = "database-retention-url" # postgres://testnotary_retention:…@…/testnotary
  }
}

resource "aws_secretsmanager_secret" "service" {
  for_each = local.service_secrets

  name                    = "${var.name}/production/${each.value}"
  description             = "Testnotary service: ${each.key}"
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret" "job" {
  for_each = local.job_secrets

  name                    = "${var.name}/production/${each.value}"
  description             = "Testnotary ${each.key} job: database connection"
  recovery_window_in_days = 30
}
