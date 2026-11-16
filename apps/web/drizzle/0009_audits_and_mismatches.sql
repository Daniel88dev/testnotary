CREATE TABLE "audit_key_versions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_key_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"repo_id" bigint NOT NULL,
	"version" integer NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_key_versions_positive" CHECK ("audit_key_versions"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "mismatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" bigint NOT NULL,
	"verification_id" uuid NOT NULL,
	"job_report_id" uuid NOT NULL,
	"result" text NOT NULL,
	"suite" text,
	"commit" text NOT NULL,
	"tree" text NOT NULL,
	"event" text NOT NULL,
	"account_id" bigint NOT NULL,
	"token_id" uuid NOT NULL,
	"token_kind" text NOT NULL,
	"token_name" text NOT NULL,
	"attestation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"attested_commit" text NOT NULL,
	"attested_at" timestamp with time zone NOT NULL,
	"attestation_ended_at" timestamp with time zone NOT NULL,
	"attestation_format" text NOT NULL,
	"attestation_payload" "bytea" NOT NULL,
	"signature" jsonb,
	"run_environment" jsonb,
	"session" jsonb,
	"ci_environment" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"skipped_commits" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mismatches_verification_id_unique" UNIQUE("verification_id")
);
--> statement-breakpoint
ALTER TABLE "audit_key_versions" ADD CONSTRAINT "audit_key_versions_repo_id_repos_github_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mismatches" ADD CONSTRAINT "mismatches_repo_id_repos_github_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_key_versions_latest" ON "audit_key_versions" USING btree ("repo_id","id");--> statement-breakpoint
CREATE INDEX "mismatches_repo" ON "mismatches" USING btree ("repo_id","created_at");--> statement-breakpoint
CREATE INDEX "mismatches_account" ON "mismatches" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "repo_setting_changes" ADD CONSTRAINT "repo_setting_changes_audit_rate" CHECK ("repo_setting_changes"."audit_one_in" between 1 and 10);--> statement-breakpoint
ALTER TABLE "repo_setting_changes" ADD CONSTRAINT "repo_setting_changes_sandbox_audit_rate" CHECK ("repo_setting_changes"."sandbox_audit_one_in" between 1 and 5);