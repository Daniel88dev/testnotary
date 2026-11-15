CREATE TABLE "installation_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "installation_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"installation_id" bigint NOT NULL,
	"action" text NOT NULL,
	"delivery_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"github_id" bigint PRIMARY KEY NOT NULL,
	"target_id" bigint NOT NULL,
	"target_login" text NOT NULL,
	"target_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_setting_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "repo_setting_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"repo_id" bigint NOT NULL,
	"mode" text NOT NULL,
	"audit_one_in" integer NOT NULL,
	"sandbox_audit_one_in" integer NOT NULL,
	"changed_by" bigint,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_states" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "repo_states_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"repo_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"visibility" text NOT NULL,
	"installed" boolean NOT NULL,
	"change" text NOT NULL,
	"delivery_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"github_id" bigint PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "installation_events" ADD CONSTRAINT "installation_events_installation_id_installations_github_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_setting_changes" ADD CONSTRAINT "repo_setting_changes_repo_id_repos_github_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_states" ADD CONSTRAINT "repo_states_repo_id_repos_github_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_states" ADD CONSTRAINT "repo_states_installation_id_installations_github_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("github_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "installation_events_latest" ON "installation_events" USING btree ("installation_id","id");--> statement-breakpoint
CREATE INDEX "repo_setting_changes_latest" ON "repo_setting_changes" USING btree ("repo_id","id");--> statement-breakpoint
CREATE INDEX "repo_states_latest" ON "repo_states" USING btree ("repo_id","id");--> statement-breakpoint
CREATE INDEX "repo_states_installation" ON "repo_states" USING btree ("installation_id");