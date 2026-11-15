# One-off jobs from the service image on Fargate, inside the VPC: the migration the deploy workflow
# runs before each release, and the slot for the scheduled retention job. Each gets only its own
# database role's secret, injected by ECS; the service never holds either.

resource "aws_ecs_cluster" "jobs" {
  name = "${var.name}-jobs"
}

resource "aws_cloudwatch_log_group" "jobs" {
  name              = "/${var.name}/jobs"
  retention_in_days = 30
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

locals {
  jobs = {
    migration = {
      command = ["node", "apps/web/dist/scripts/migrate.mjs"]
      env     = "MIGRATION_DATABASE_URL"
    }
    retention = {
      command = var.retention_command
      env     = "RETENTION_DATABASE_URL"
    }
  }
}

# Pulls the image, writes logs and injects the job's one secret.
resource "aws_iam_role" "job_execution" {
  for_each           = local.jobs
  name               = "${var.name}-${each.key}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "job_execution" {
  for_each   = local.jobs
  role       = aws_iam_role.job_execution[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "job_secret" {
  for_each = local.jobs
  name     = "read-${each.key}-secret"
  role     = aws_iam_role.job_execution[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [aws_secretsmanager_secret.job[each.key].arn]
    }]
  })
}

# The job's own identity: no AWS permissions at all.
resource "aws_iam_role" "job_task" {
  for_each           = local.jobs
  name               = "${var.name}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

# The deploy workflow registers a new revision with each release's image; Terraform creates the
# first one from the initial image.
resource "aws_ecs_task_definition" "job" {
  for_each = local.jobs

  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.job_execution[each.key].arn
  task_role_arn            = aws_iam_role.job_task[each.key].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name      = each.key
    image     = "${aws_ecr_repository.web.repository_url}:${var.initial_image_tag}"
    essential = true
    command   = each.value.command
    secrets   = [{ name = each.value.env, valueFrom = aws_secretsmanager_secret.job[each.key].arn }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.jobs.name
        awslogs-region        = var.region
        awslogs-stream-prefix = each.key
      }
    }
  }])

  lifecycle {
    ignore_changes = [container_definitions]
  }
}

# The retention job's scheduled slot. Off until the retention job ships (retention_job_enabled).
resource "aws_iam_role" "scheduler" {
  name = "${var.name}-retention-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  name = "run-retention-job"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Action    = ["ecs:RunTask"]
        Resource  = ["arn:aws:ecs:${var.region}:*:task-definition/${aws_ecs_task_definition.job["retention"].family}:*"]
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.jobs.arn } }
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.job_execution["retention"].arn, aws_iam_role.job_task["retention"].arn]
      },
    ]
  })
}

resource "aws_scheduler_schedule" "retention" {
  name                         = "${var.name}-retention"
  description                  = "Testnotary retention job (deletes as the retention role)"
  state                        = var.retention_job_enabled ? "ENABLED" : "DISABLED"
  schedule_expression          = var.retention_schedule
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_ecs_cluster.jobs.arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      # The family without a revision: the latest one the deploy registered.
      task_definition_arn = aws_ecs_task_definition.job["retention"].arn_without_revision
      launch_type         = "FARGATE"
      task_count          = 1

      network_configuration {
        subnets          = var.private_subnet_ids
        security_groups  = [aws_security_group.jobs.id]
        assign_public_ip = false
      }
    }

    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}
