CREATE TABLE "care_link_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"caregiver_email" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resend_timestamps" timestamp with time zone[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "invites_email_lower" CHECK ("care_link_invites"."caregiver_email" = lower("care_link_invites"."caregiver_email")),
	CONSTRAINT "invites_status_enum" CHECK ("care_link_invites"."status" IN ('pending','accepted','declined','expired','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "care_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"caregiver_id" uuid NOT NULL,
	"caregiver_email" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	CONSTRAINT "links_email_lower" CHECK ("care_links"."caregiver_email" = lower("care_links"."caregiver_email")),
	CONSTRAINT "links_status_enum" CHECK ("care_links"."status" IN ('active','ended')),
	CONSTRAINT "links_ended_consistency" CHECK (("care_links"."status" = 'ended') = ("care_links"."ended_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "care_link_invites_token_hash_key" ON "care_link_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_invites_patient_status" ON "care_link_invites" USING btree ("patient_id","status");--> statement-breakpoint
CREATE INDEX "idx_invites_email_status" ON "care_link_invites" USING btree ("caregiver_email","status");--> statement-breakpoint
CREATE INDEX "idx_invites_status_expires" ON "care_link_invites" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_links_active_pair" ON "care_links" USING btree ("patient_id","caregiver_id") WHERE "care_links"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_links_patient_status" ON "care_links" USING btree ("patient_id","status");--> statement-breakpoint
CREATE INDEX "idx_links_caregiver_status" ON "care_links" USING btree ("caregiver_id","status");--> statement-breakpoint
CREATE INDEX "idx_links_active_email" ON "care_links" USING btree ("patient_id","caregiver_email") WHERE "care_links"."status" = 'active';