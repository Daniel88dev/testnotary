# What the deploy workflow needs, set as variables of the GitHub `production` environment
# (not secrets: none of these grants anything without the OIDC trust).

output "deploy_role_arn" {
  description = "AWS_DEPLOY_ROLE_ARN"
  value       = aws_iam_role.deploy.arn
}

output "ecr_repository_url" {
  description = "ECR_REPOSITORY_URL"
  value       = aws_ecr_repository.web.repository_url
}

output "apprunner_service_arn" {
  description = "APPRUNNER_SERVICE_ARN"
  value       = aws_apprunner_service.web.arn
}

output "service_url" {
  description = "The App Runner default domain."
  value       = "https://${aws_apprunner_service.web.service_url}"
}

output "jobs_cluster_arn" {
  description = "JOBS_CLUSTER_ARN"
  value       = aws_ecs_cluster.jobs.arn
}

output "job_subnet_ids" {
  description = "JOB_SUBNET_IDS (comma-separated)"
  value       = join(",", var.private_subnet_ids)
}

output "job_security_group_id" {
  description = "JOB_SECURITY_GROUP_ID"
  value       = aws_security_group.jobs.id
}

output "database_host" {
  description = "Host for the connection strings put into the database secrets."
  value       = local.database_host
}

output "secret_names" {
  description = "The Secrets Manager entries to fill by hand."
  value = merge(
    { for env, secret in aws_secretsmanager_secret.service : env => secret.name },
    { for job, secret in aws_secretsmanager_secret.job : "${job} job" => secret.name },
  )
}

output "custom_domain_validation_records" {
  description = "DNS records to create for the custom domain."
  value       = var.custom_domain == null ? [] : aws_apprunner_custom_domain_association.web[0].certificate_validation_records
}
