CREATE TABLE "mismatch_explanations" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mismatch_explanations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"mismatch_id" uuid NOT NULL,
	"cause" text NOT NULL,
	"note" text NOT NULL,
	"explained_by" bigint NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mismatch_explanations_mismatch_id_unique" UNIQUE("mismatch_id"),
	CONSTRAINT "mismatch_explanations_cause" CHECK ("mismatch_explanations"."cause" in ('flaky_test', 'environment_difference', 'false_attestation', 'other'))
);
--> statement-breakpoint
ALTER TABLE "mismatch_explanations" ADD CONSTRAINT "mismatch_explanations_mismatch_id_mismatches_id_fk" FOREIGN KEY ("mismatch_id") REFERENCES "public"."mismatches"("id") ON DELETE no action ON UPDATE no action;