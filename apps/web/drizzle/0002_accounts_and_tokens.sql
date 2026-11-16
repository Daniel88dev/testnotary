CREATE TABLE "account_logins" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_logins_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" bigint NOT NULL,
	"login" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"github_id" bigint PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_revocations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "token_revocations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"token_id" uuid NOT NULL,
	"revoked_by" bigint,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "token_revocations_token_id_unique" UNIQUE("token_id")
);
--> statement-breakpoint
CREATE TABLE "token_secrets" (
	"token_id" uuid PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	CONSTRAINT "token_secrets_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "token_uses" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "token_uses_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"token_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"account_id" bigint NOT NULL,
	"name" text NOT NULL,
	"repo_id" bigint,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_logins" ADD CONSTRAINT "account_logins_account_id_accounts_github_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_revocations" ADD CONSTRAINT "token_revocations_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_revocations" ADD CONSTRAINT "token_revocations_revoked_by_accounts_github_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."accounts"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_secrets" ADD CONSTRAINT "token_secrets_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_uses" ADD CONSTRAINT "token_uses_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_account_id_accounts_github_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_repo_id_repos_github_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_logins_latest" ON "account_logins" USING btree ("account_id","id");--> statement-breakpoint
CREATE INDEX "token_uses_latest" ON "token_uses" USING btree ("token_id","id");--> statement-breakpoint
CREATE INDEX "tokens_account" ON "tokens" USING btree ("account_id");