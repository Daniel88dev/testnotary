CREATE TABLE "attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"repo_id" bigint NOT NULL,
	"suite" text NOT NULL,
	"tree" text NOT NULL,
	"commit" text NOT NULL,
	"token_id" uuid NOT NULL,
	"account_id" bigint NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"format" text NOT NULL,
	"payload" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attestations_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" bigint NOT NULL,
	"token_id" uuid NOT NULL,
	"account_id" bigint NOT NULL,
	"outcome" text NOT NULL,
	"refusal" text,
	"suite" text,
	"tree" text,
	"commit" text,
	"command" jsonb,
	"exit_code" integer,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"environment" jsonb,
	"session" jsonb,
	"passed_env" jsonb NOT NULL,
	"guarded_matched" jsonb NOT NULL,
	"warnings" jsonb NOT NULL,
	"not_pinned" jsonb NOT NULL,
	"baseline_overrides" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_repo_id_repos_github_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attestations" ADD CONSTRAINT "attestations_account_id_accounts_github_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_repo_id_repos_github_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_account_id_accounts_github_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attestations_lookup" ON "attestations" USING btree ("repo_id","suite","tree");--> statement-breakpoint
CREATE INDEX "runs_repo" ON "runs" USING btree ("repo_id","received_at");--> statement-breakpoint
CREATE INDEX "runs_account" ON "runs" USING btree ("account_id");