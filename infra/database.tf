# Where the `testnotary` database lives (ADR 0002 and its amendment).
#
# `shared`: on the existing RDS instance, found by identifier. Terraform only opens the instance's
# security group to the connector and the jobs, and refuses unless the conditions it can see hold
# and the maintainer confirmed the rest (docs/runbook/hosting.md).
#
# `dedicated` (the default until then): an instance of its own, private, encrypted, with the master
# password managed and rotated by RDS.
#
# Either way the database and its three roles are created once with infra/database/bootstrap.sql,
# from a bastion session; Terraform never holds a database password.

data "aws_db_instance" "shared" {
  count                  = var.database == "shared" ? 1 : 0
  db_instance_identifier = var.shared_rds_instance_identifier

  lifecycle {
    postcondition {
      condition     = var.shared_instance_launch_conditions_confirmed
      error_message = "ADR 0002: the shared instance is allowed only after the runbook's launch-condition check passed. Set shared_instance_launch_conditions_confirmed = true once it has, or use database = \"dedicated\"."
    }
    postcondition {
      condition     = !self.publicly_accessible
      error_message = "ADR 0002, condition 4: the shared instance is reachable from the internet."
    }
    postcondition {
      condition     = length(self.master_user_secret) > 0
      error_message = "ADR 0002, condition 1: RDS does not manage the master password (no master user secret), so an app may still hold it."
    }
  }
}

resource "aws_vpc_security_group_ingress_rule" "shared_postgres" {
  for_each = var.database == "shared" ? {
    for pair in setproduct(data.aws_db_instance.shared[0].vpc_security_groups, ["service", "jobs"]) :
    "${pair[0]}-${pair[1]}" => { database = pair[0], source = pair[1] }
  } : {}

  security_group_id            = each.value.database
  description                  = "Testnotary ${each.value.source}"
  ip_protocol                  = "tcp"
  from_port                    = local.database_port
  to_port                      = local.database_port
  referenced_security_group_id = each.value.source == "service" ? aws_security_group.service.id : aws_security_group.jobs.id
}

resource "aws_security_group" "database" {
  count       = var.database == "dedicated" ? 1 : 0
  name        = "${var.name}-database"
  description = "Testnotary Postgres"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "dedicated_postgres" {
  for_each = var.database == "dedicated" ? { service = aws_security_group.service.id, jobs = aws_security_group.jobs.id } : {}

  security_group_id            = aws_security_group.database[0].id
  description                  = "Testnotary ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = each.value
}

resource "aws_db_subnet_group" "dedicated" {
  count      = var.database == "dedicated" ? 1 : 0
  name       = "${var.name}-production"
  subnet_ids = var.private_subnet_ids
}

resource "aws_db_instance" "dedicated" {
  count = var.database == "dedicated" ? 1 : 0

  identifier     = "${var.name}-production"
  engine         = "postgres"
  engine_version = "17"
  instance_class = var.dedicated_instance_class

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  username                            = "testnotary_admin"
  manage_master_user_password         = true
  iam_database_authentication_enabled = false

  db_subnet_group_name   = aws_db_subnet_group.dedicated[0].name
  vpc_security_group_ids = [aws_security_group.database[0].id]
  publicly_accessible    = false
  multi_az               = false

  backup_retention_period    = 7
  deletion_protection        = true
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${var.name}-production-final"
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true
}

locals {
  database_port = var.database == "shared" ? data.aws_db_instance.shared[0].port : 5432
  database_host = var.database == "shared" ? data.aws_db_instance.shared[0].address : aws_db_instance.dedicated[0].address
}
