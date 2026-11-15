CREATE TABLE "oidc_token_uses" (
	"jti" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" bigint NOT NULL,
	"suite" text,
	"commit" text NOT NULL,
	"tree" text NOT NULL,
	"event" text NOT NULL,
	"iss" text NOT NULL,
	"mode" text NOT NULL,
	"result" text NOT NULL,
	"reason" text,
	"attestation_id" uuid,
	"environment" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_repo_id_repos_github_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_attestation_id_attestations_id_fk" FOREIGN KEY ("attestation_id") REFERENCES "public"."attestations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verifications_repo" ON "verifications" USING btree ("repo_id","created_at");