ALTER TABLE "pending_questions" ALTER COLUMN "asked_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_questions" ADD COLUMN "kind" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_questions" ADD COLUMN "answer" text;--> statement-breakpoint
ALTER TABLE "pending_questions" ADD COLUMN "updates_left" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "replies" ADD COLUMN "expects_group" boolean DEFAULT false NOT NULL;