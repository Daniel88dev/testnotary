ALTER TABLE "verifications" ADD COLUMN "ci_run_id" bigint;--> statement-breakpoint
ALTER TABLE "verifications" ADD COLUMN "ci_run_attempt" integer;--> statement-breakpoint
ALTER TABLE "verifications" ADD COLUMN "ci_job_id" bigint;