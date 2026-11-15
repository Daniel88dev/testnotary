CREATE TABLE "token_blocks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "token_blocks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"token_id" uuid NOT NULL,
	"repo_id" bigint NOT NULL,
	"blocked_by" bigint NOT NULL,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "token_blocks_token_repo" UNIQUE("token_id","repo_id")
);
--> statement-breakpoint
ALTER TABLE "token_blocks" ADD CONSTRAINT "token_blocks_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_blocks" ADD CONSTRAINT "token_blocks_repo_id_repos_github_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_blocks" ADD CONSTRAINT "token_blocks_blocked_by_accounts_github_id_fk" FOREIGN KEY ("blocked_by") REFERENCES "public"."accounts"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "token_blocks_repo" ON "token_blocks" USING btree ("repo_id");