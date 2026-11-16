CREATE TABLE "account_deletions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_deletions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" bigint NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account_suspensions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_suspensions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"account_id" bigint NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_account_id_accounts_github_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_suspensions" ADD CONSTRAINT "account_suspensions_account_id_accounts_github_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_deletions_latest" ON "account_deletions" USING btree ("account_id","id");--> statement-breakpoint
CREATE INDEX "account_suspensions_latest" ON "account_suspensions" USING btree ("account_id","id");