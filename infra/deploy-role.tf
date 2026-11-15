# The role the deploy workflow assumes through GitHub's OIDC. It trusts one subject only: this
# repository's `main` branch in the `production` environment. There are no stored AWS keys.

# The account already has GitHub's OIDC provider (other products deploy with it); reuse it.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "deploy" {
  name                 = "${var.name}-deploy"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = var.github_oidc_subject
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "deploy" {
  name = "deploy-testnotary"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrLogin"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "EcrPush"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeImages",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ]
        Resource = aws_ecr_repository.web.arn
      },
      {
        Sid      = "AppRunnerDeploy"
        Effect   = "Allow"
        Action   = ["apprunner:DescribeService", "apprunner:UpdateService", "apprunner:ListOperations"]
        Resource = aws_apprunner_service.web.arn
      },
      {
        Sid      = "JobTaskDefinitions"
        Effect   = "Allow"
        Action   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
        Resource = "*"
      },
      {
        Sid       = "RunMigration"
        Effect    = "Allow"
        Action    = ["ecs:RunTask"]
        Resource  = ["arn:aws:ecs:${var.region}:*:task-definition/${aws_ecs_task_definition.job["migration"].family}:*"]
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.jobs.arn } }
      },
      {
        Sid       = "WatchMigration"
        Effect    = "Allow"
        Action    = ["ecs:DescribeTasks"]
        Resource  = "*"
        Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.jobs.arn } }
      },
      {
        Sid      = "ReadMigrationLogs"
        Effect   = "Allow"
        Action   = ["logs:GetLogEvents"]
        Resource = "${aws_cloudwatch_log_group.jobs.arn}:*"
      },
      {
        Sid    = "PassJobRoles"
        Effect = "Allow"
        Action = ["iam:PassRole"]
        Resource = flatten([
          for job in keys(local.jobs) : [aws_iam_role.job_execution[job].arn, aws_iam_role.job_task[job].arn]
        ])
        Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } }
      },
      {
        Sid       = "PassImagePullRole"
        Effect    = "Allow"
        Action    = ["iam:PassRole"]
        Resource  = [aws_iam_role.apprunner_access.arn]
        Condition = { StringEquals = { "iam:PassedToService" = "build.apprunner.amazonaws.com" } }
      },
    ]
  })
}
