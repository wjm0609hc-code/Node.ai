CREATE TABLE "cards" (
	"id" text PRIMARY KEY NOT NULL,
	"group_id" uuid,
	"data" jsonb NOT NULL,
	"photo_url" text,
	"page_url" text,
	"target_url" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "groups" ADD COLUMN "service" text;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;