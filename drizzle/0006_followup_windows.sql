ALTER TABLE "pending_questions" ALTER COLUMN "asked_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_questions" ADD COLUMN "kind" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "expects_group" boolean DEFAULT false NOT NULL;