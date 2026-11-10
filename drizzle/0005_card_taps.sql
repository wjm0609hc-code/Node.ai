CREATE TABLE "card_taps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" text NOT NULL,
	"group_id" uuid,
	"early" boolean DEFAULT false NOT NULL,
	"tapped_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "card_taps" ADD CONSTRAINT "card_taps_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_taps" ADD CONSTRAINT "card_taps_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_taps_card_idx" ON "card_taps" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "card_taps_tapped_idx" ON "card_taps" USING btree ("tapped_at");--> statement-breakpoint
CREATE INDEX "cards_created_idx" ON "cards" USING btree ("created_at");