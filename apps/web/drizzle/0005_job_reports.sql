CREATE TABLE "job_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"verification_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"environment" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_reports" ADD CONSTRAINT "job_reports_verification_id_verifications_id_fk" FOREIGN KEY ("verification_id") REFERENCES "public"."verifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_reports_verification" ON "job_reports" USING btree ("verification_id","created_at");