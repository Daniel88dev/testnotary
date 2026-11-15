# Hosting runbook

Testnotary's service runs on AWS App Runner in `eu-central-1`, built from `apps/web/Dockerfile`
and described by the Terraform in `infra/`. The agent that wrote this never applied it: every step
below needs the maintainer's AWS access.

Never committed: Terraform state, `production.tfvars`, `backend.hcl`, account ids, instance
identifiers, endpoints, and every secret value.

## 1. Check ADR 0002's launch conditions

The `testnotary` database may go on the shared RDS instance only when all four conditions hold.
Run these checks just before launch; if any fails, keep `database = "dedicated"` (the default) and
Testnotary gets an instance of its own. Flexi-day-be's half of the work is T-802.

1. **No app connects as the master user.** RDS manages the master password and no app reads it:
   `aws rds describe-db-instances --db-instance-identifier <id> --query 'DBInstances[0].MasterUserSecret'`
   returns a secret (Terraform also refuses the shared instance without one). Then, as the master,
   `select distinct usename, datname from pg_stat_activity where backend_type = 'client backend';`
   over a normal day shows each product under its own owner role, never the master user. Check each
   product's `DATABASE_URL` secret names its own role too.
2. **No Testnotary role is privileged, and connections are fenced.** After the bootstrap SQL ran:
   ```sql
   select rolname, rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname like 'testnotary_%';
   -- all false
   select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.member
     join pg_roles g on g.oid = m.roleid where g.rolname = 'rds_superuser' and r.rolname like 'testnotary_%';
   -- no rows
   select d.datname, r.rolname from pg_database d cross join pg_roles r
     where r.rolname like 'testnotary_%' and has_database_privilege(r.oid, d.oid, 'CONNECT')
       and d.datname <> 'testnotary';
   -- no rows
   select datname, datacl from pg_database where not datistemplate;
   -- neither product's database grants CONNECT to PUBLIC (no "=c/" or "=Tc/" entry)
   ```
3. **The instance's Terraform state is in an encrypted remote backend.** In the repo that manages
   the instance, the `backend` block is `s3` (or another remote backend) with encryption on,
   `aws s3api get-bucket-encryption --bucket <state bucket>` shows KMS or AES256, the bucket blocks
   public access, and no `terraform.tfstate` for it exists on any laptop.
4. **Postgres is not reachable from the internet.** `PubliclyAccessible` is `false`
   (Terraform also refuses the shared instance otherwise), no inbound rule of its security groups
   allows `0.0.0.0/0` or `::/0`, every app on it reaches it through a VPC connector
   (`aws apprunner describe-service … --query 'Service.NetworkConfiguration.EgressConfiguration'`
   shows `VPC` for each), and migrations run from CI or a bastion session, never from a laptop.

When all four hold, set in `production.tfvars`:

```hcl
database                                    = "shared"
shared_rds_instance_identifier              = "<id>"
shared_instance_launch_conditions_confirmed = true
```

Move Testnotary to an instance of its own before the beta ends, or sooner at the first of: a
security incident in either product, 25 repos in enforce mode, the shared instance's CPU or
connections above 70% for a day, or a security review that asks for it. The code needs only a new
`DATABASE_URL` (and the job secrets), so the move is a data migration.

## 2. First setup

1. **State bucket.** Create an S3 bucket for Terraform state with versioning, default KMS
   encryption and all public access blocked. Copy `infra/backend.hcl.example` to
   `infra/backend.hcl`, fill it in, `terraform init -backend-config=backend.hcl`.
2. **Variables.** Copy `infra/production.tfvars.example` to `infra/production.tfvars`. The private
   subnets need a NAT route: the service and the jobs reach GitHub, Sentry, Secrets Manager and ECR
   through it.
3. **GitHub.** Create the `production` environment with a deployment branch rule allowing `main`
   only. Make the OIDC subject name the ref as well as the environment:
   `gh api -X PUT repos/Daniel88dev/testnotary/actions/oidc/customization/sub -F use_default=false -f 'include_claim_keys[]=repo' -f 'include_claim_keys[]=context' -f 'include_claim_keys[]=ref'`.
   If the repository uses GitHub's immutable-id subject form (repos created after 2026-07-15), the
   `repo` part reads `Daniel88dev@<owner id>/testnotary@<repo id>`: set `github_oidc_subject` to
   that form in `production.tfvars`.
4. **The first image.** `terraform apply -var-file=production.tfvars -target=aws_ecr_repository.web`,
   then build and push one image tagged with the current commit
   (`docker build --platform linux/amd64 -f apps/web/Dockerfile --build-arg SENTRY_RELEASE=<sha> -t <ecr url>:<sha> .`)
   and set `initial_image_tag` to that sha.
5. **Everything else.** `terraform apply -var-file=production.tfvars`. App Runner's first
   deployment fails its health check until the database secret is filled; that is expected.
6. **Database.** From a bastion session in the VPC, run `infra/database/bootstrap.sql` as the
   instance's master user (passwords as psql variables, see the file's header).
7. **Secrets.** Put each value into the entry named in the `secret_names` output, for example
   `aws secretsmanager put-secret-value --secret-id testnotary/production/database-url --secret-string file://-`
   (read from stdin, so the value never sits in shell history):
   - `database-url`: `postgres://testnotary_app:<pw>@<database_host>:5432/testnotary?sslmode=require`
     (encrypted inside the VPC; `verify-full` would need the RDS CA bundle in the image through
     `NODE_EXTRA_CA_CERTS`, which it does not carry yet)
   - `database-migration-url`, `database-retention-url`: the same for those roles
   - `github-app-webhook-secret`, `github-app-private-key`, `github-app-client-secret`: from the
     GitHub App's settings (its webhook URL is `https://<domain>/api/v1/github/webhooks`)
   - `audit-master-key`: 32 random bytes, base64 (`openssl rand -base64 32`)
   - `better-auth-secret`: `openssl rand -base64 32`
8. **Deploy variables.** In the `production` environment, set the variables `AWS_DEPLOY_ROLE_ARN`,
   `ECR_REPOSITORY_URL`, `APPRUNNER_SERVICE_ARN`, `JOBS_CLUSTER_ARN`, `JOB_SUBNET_IDS` and
   `JOB_SECURITY_GROUP_ID` from the Terraform outputs of the same names.
9. **First deploy.** Run the Deploy workflow on `main` (or push to `main`). It migrates, then moves
   App Runner to the new image; `https://<service_url>/api/v1/health` answers
   `{"status":"ok","database":"ok"}`.
10. **Logs.** Set 30-day retention on App Runner's log groups once they exist:
    `aws logs put-retention-policy --log-group-name /aws/apprunner/testnotary-production/<id>/application --retention-in-days 30`
    (and `…/service`). The jobs' log group already keeps 30 days.

## 3. Operating it

- **Deploys** run on every push to `main`. A secret the service cannot read, or a database it
  cannot reach, fails the health check; App Runner keeps the previous version and the workflow
  fails. A failed migration stops the workflow before App Runner changes.
- **Rollback**: revert on `main`; the deploy ships the revert. Migrations only move forward, so the
  reverted code must still work with the newer schema.
- **Sentry** receives the service's errors only: request errors, an unreachable database from the
  health route, and a secret that cannot be read at start. No browser SDK, no tracing, and no
  request headers, cookies, bodies or query strings. The library and the action send nothing.
  Rotate the DSN in `production.tfvars` and apply.
- **Rotating a secret**: put the new value, then redeploy (or pause and resume the service); the
  server reads secrets when it starts.
- **Retention job**: the schedule `testnotary-retention` exists, disabled. When the retention job
  ships, set `retention_job_enabled = true` (and `retention_command` if its path differs) and apply.
- **Custom domain**: set `custom_domain`, apply, and create the records from
  `custom_domain_validation_records`. Before `testnotary.dev` is bought, a subdomain of an existing
  domain works, with clients pointed at it through `TESTNOTARY_URL`.
