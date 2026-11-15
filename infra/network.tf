# The service reaches Postgres only through its own VPC connector, and the one-off jobs run in the
# same private subnets. Neither is reachable from the internet.

resource "aws_security_group" "service" {
  name        = "${var.name}-service"
  description = "Testnotary App Runner VPC connector"
  vpc_id      = var.vpc_id
}

resource "aws_security_group" "jobs" {
  name        = "${var.name}-jobs"
  description = "Testnotary one-off jobs (migration, retention)"
  vpc_id      = var.vpc_id
}

# Outbound: Postgres inside the VPC, HTTPS (GitHub, Sentry, Secrets Manager, ECR) through the NAT.
resource "aws_vpc_security_group_egress_rule" "https" {
  for_each = { service = aws_security_group.service.id, jobs = aws_security_group.jobs.id }

  security_group_id = each.value
  description       = "HTTPS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "postgres" {
  for_each = { service = aws_security_group.service.id, jobs = aws_security_group.jobs.id }

  security_group_id = each.value
  description       = "Postgres in the VPC"
  ip_protocol       = "tcp"
  from_port         = local.database_port
  to_port           = local.database_port
  cidr_ipv4         = data.aws_vpc.this.cidr_block
}

data "aws_vpc" "this" {
  id = var.vpc_id
}

resource "aws_apprunner_vpc_connector" "service" {
  vpc_connector_name = "${var.name}-production"
  subnets            = var.private_subnet_ids
  security_groups    = [aws_security_group.service.id]
}
