# Every account-specific value is a variable without a default. They are set in a
# production.tfvars that is never committed (see production.tfvars.example).

variable "region" {
  description = "AWS region of the service."
  type        = string
  default     = "eu-central-1"
}

variable "name" {
  description = "Name prefix for every resource."
  type        = string
  default     = "testnotary"
}

variable "github_repository" {
  description = "The repository whose main branch deploys, as owner/name."
  type        = string
  default     = "Daniel88dev/testnotary"
}

variable "github_oidc_subject" {
  description = <<-EOT
    The `sub` claim the deploy role trusts. The default needs the repository's OIDC subject
    template to include `ref` (`include_claim_keys = ["repo", "context", "ref"]`), so the claim
    names both the `production` environment and `refs/heads/main`. If the repository uses
    GitHub's immutable-id subject form, set the id form here (see the runbook).
  EOT
  type        = string
  default     = "repo:Daniel88dev/testnotary:environment:production:ref:refs/heads/main"
}

variable "vpc_id" {
  description = "VPC of the database. The service's VPC connector and the jobs run in it."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets for the VPC connector and the jobs. They need a NAT route: the service reaches GitHub, Sentry, Secrets Manager and ECR through it."
  type        = list(string)
}

variable "database" {
  description = "`shared`: the testnotary database on the existing RDS instance, allowed only when ADR 0002's four launch conditions hold. `dedicated`: an instance of its own."
  type        = string
  default     = "dedicated"

  validation {
    condition     = contains(["shared", "dedicated"], var.database)
    error_message = "database is either \"shared\" or \"dedicated\"."
  }
}

variable "shared_rds_instance_identifier" {
  description = "Identifier of the shared RDS instance (database = shared)."
  type        = string
  default     = null
}

variable "shared_instance_launch_conditions_confirmed" {
  description = "Set to true only after the runbook's check of ADR 0002's four launch conditions passed. Terraform refuses the shared instance otherwise."
  type        = bool
  default     = false
}

variable "dedicated_instance_class" {
  description = "Instance class of the dedicated instance (database = dedicated)."
  type        = string
  default     = "db.t4g.micro"
}

variable "initial_image_tag" {
  description = "Image tag the App Runner service is created with. Later deploys move it from the workflow, and Terraform ignores the change."
  type        = string
}

variable "cpu" {
  description = "App Runner vCPU per instance."
  type        = string
  default     = "0.5 vCPU"
}

variable "memory" {
  description = "App Runner memory per instance."
  type        = string
  default     = "1 GB"
}

variable "max_instances" {
  description = "Upper bound of App Runner's autoscaling."
  type        = number
  default     = 2
}

variable "sentry_dsn" {
  description = "Sentry DSN of the service. Empty turns reporting off."
  type        = string
  default     = ""
}

variable "custom_domain" {
  description = "Domain to associate with the service (e.g. testnotary.dev, or a test subdomain before it is bought). Null for none."
  type        = string
  default     = null
}

variable "retention_job_enabled" {
  description = "Turns the retention job's schedule on. Leave false until the retention job ships."
  type        = bool
  default     = false
}

variable "retention_schedule" {
  description = "EventBridge Scheduler expression for the retention job."
  type        = string
  default     = "cron(30 3 * * ? *)"
}

variable "retention_command" {
  description = "Command of the retention job inside the service image."
  type        = list(string)
  default     = ["node", "apps/web/dist/scripts/retention.mjs"]
}
