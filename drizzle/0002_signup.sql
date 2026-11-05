CREATE TYPE "public"."signup_source" AS ENUM('text', 'web', 'group');--> statement-breakpoint
CREATE TABLE "web_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"ip_hash" text NOT NULL,
	"texted" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "texts_stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "source" "signup_source" DEFAULT 'text' NOT NULL;--> statement-breakpoint
CREATE INDEX "web_signups_phone_idx" ON "web_signups" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "web_signups_ip_idx" ON "web_signups" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "web_signups_created_idx" ON "web_signups" USING btree ("created_at");