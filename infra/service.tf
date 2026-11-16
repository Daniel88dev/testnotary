# The web app on App Runner, from its own ECR repository.

resource "aws_ecr_repository" "web" {
  name                 = "${var.name}-web"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "web" {
  repository = aws_ecr_repository.web.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

# App Runner pulls the image with this role.
resource "aws_iam_role" "apprunner_access" {
  name = "${var.name}-apprunner-ecr-access"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "build.apprunner.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "apprunner_access" {
  role       = aws_iam_role.apprunner_access.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

# The running service: reads its own secrets and nothing else. Not the migration or retention ones.
resource "aws_iam_role" "service" {
  name = "${var.name}-service"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "tasks.apprunner.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "service_secrets" {
  name = "read-service-secrets"
  role = aws_iam_role.service.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [for secret in aws_secretsmanager_secret.service : secret.arn]
    }]
  })
}

resource "aws_apprunner_auto_scaling_configuration_version" "web" {
  auto_scaling_configuration_name = "${var.name}-production"
  min_size                        = 1
  max_size                        = var.max_instances
  max_concurrency                 = 100
}

resource "aws_apprunner_service" "web" {
  service_name = "${var.name}-production"

  source_configuration {
    auto_deployments_enabled = false

    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_access.arn
    }

    image_repository {
      image_repository_type = "ECR"
      image_identifier      = "${aws_ecr_repository.web.repository_url}:${var.initial_image_tag}"

      image_configuration {
        port = "3000"
        runtime_environment_variables = merge(
          {
            AWS_REGION         = var.region
            GITHUB_CLIENT_ID   = var.github_client_id
            GITHUB_APP_ID      = var.github_app_id
            SENTRY_DSN         = var.sentry_dsn
            SENTRY_ENVIRONMENT = "production"
          },
          # Secrets as references, resolved by the server when it starts.
          { for env, secret in aws_secretsmanager_secret.service : env => "secretsmanager:${secret.arn}" },
        )
      }
    }
  }

  instance_configuration {
    cpu               = var.cpu
    memory            = var.memory
    instance_role_arn = aws_iam_role.service.arn
  }

  network_configuration {
    ingress_configuration {
      is_publicly_accessible = true
    }
    egress_configuration {
      egress_type       = "VPC"
      vpc_connector_arn = aws_apprunner_vpc_connector.service.arn
    }
  }

  health_check_configuration {
    protocol            = "HTTP"
    path                = "/api/v1/health"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }

  auto_scaling_configuration_arn = aws_apprunner_auto_scaling_configuration_version.web.arn

  lifecycle {
    # The deploy workflow moves the image; Terraform owns everything else.
    ignore_changes = [source_configuration[0].image_repository[0].image_identifier]
  }

  depends_on = [aws_iam_role_policy_attachment.apprunner_access]
}

resource "aws_apprunner_custom_domain_association" "web" {
  count                = var.custom_domain == null ? 0 : 1
  service_arn          = aws_apprunner_service.web.arn
  domain_name          = var.custom_domain
  enable_www_subdomain = false
}

# App Runner's own log groups, with the 30 days the privacy policy promises for request logs (which
# carry IPs). App Runner names them after the service and writes to them from its first deployment;
# Terraform creates them right after the service, so they keep 30 days from the start. If App Runner
# got there first, import each one (docs/runbook/hosting.md, step 10).
resource "aws_cloudwatch_log_group" "apprunner" {
  for_each          = toset(["application", "service"])
  name              = "/aws/apprunner/${aws_apprunner_service.web.service_name}/${aws_apprunner_service.web.service_id}/${each.key}"
  retention_in_days = 30
}
