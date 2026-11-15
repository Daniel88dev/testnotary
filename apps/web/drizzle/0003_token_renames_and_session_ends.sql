CREATE TABLE "session_ends" (
	"session_id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_renames" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "token_renames_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"token_id" uuid NOT NULL,
	"name" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "token_renames" ADD CONSTRAINT "token_renames_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "token_renames_latest" ON "token_renames" USING btree ("token_id","id");