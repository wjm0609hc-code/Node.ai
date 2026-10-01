CREATE TYPE "public"."access_status" AS ENUM('waitlist', 'active');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('proposed', 'confirming', 'link_sent', 'booked', 'cancelled', 'declined', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."collection_status" AS ENUM('setup', 'collecting', 'captured', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."decision_status" AS ENUM('open', 'runoff', 'decided', 'funded', 'booked', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."option_kind" AS ENUM('rental', 'restaurant', 'activity', 'event', 'ticket', 'other');--> statement-breakpoint
CREATE TYPE "public"."option_source" AS ENUM('link', 'search');--> statement-breakpoint
CREATE TYPE "public"."payment_request_status" AS ENUM('pending', 'authorized', 'capturing', 'captured', 'cancelled', 'failed');--> statement-breakpoint
CREATE TYPE "public"."service" AS ENUM('imessage', 'sms');--> statement-breakpoint
CREATE TABLE "booking_approvals" (
	"booking_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "booking_approvals_booking_id_user_id_pk" PRIMARY KEY("booking_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"decision_id" uuid,
	"requested_by_user_id" uuid,
	"party_size" integer NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"all_day" boolean DEFAULT false NOT NULL,
	"link" text,
	"method" text DEFAULT 'link' NOT NULL,
	"partner" text,
	"partner_booking_id" text,
	"holder_user_id" uuid,
	"proposal" jsonb,
	"proposal_message_id" text,
	"free_cancel_until" timestamp with time zone,
	"reminder_sent_at" timestamp with time zone,
	"status" "booking_status" DEFAULT 'link_sent' NOT NULL,
	"booked_by_user_id" uuid,
	"confirmation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "date_poll_choices" (
	"decision_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"starts_on" text NOT NULL,
	"ends_on" text,
	"chosen" boolean DEFAULT false NOT NULL,
	"message_id" text,
	CONSTRAINT "date_poll_choices_decision_id_position_pk" PRIMARY KEY("decision_id","position")
);
--> statement-breakpoint
CREATE TABLE "date_poll_responses" (
	"decision_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"positions" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "date_poll_responses_decision_id_user_id_pk" PRIMARY KEY("decision_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "decision_options" (
	"decision_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"message_id" text,
	CONSTRAINT "decision_options_decision_id_option_id_pk" PRIMARY KEY("decision_id","option_id")
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"question" text NOT NULL,
	"status" "decision_status" DEFAULT 'open' NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"parent_decision_id" uuid,
	"created_by_user_id" uuid,
	"winning_option_id" uuid,
	"deadline_at" timestamp with time zone,
	"tie_break_user_id" uuid,
	"nudge_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"booking_id" uuid,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"location" text,
	"description" text,
	"sequence" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"created_by_user_id" uuid,
	"reminder_at" timestamp with time zone,
	"reminder_sent_at" timestamp with time zone,
	"wrap_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"opted_out" boolean DEFAULT false NOT NULL,
	"settings_token" text,
	CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id"),
	CONSTRAINT "group_members_settings_token_unique" UNIQUE("settings_token")
);
--> statement-breakpoint
CREATE TABLE "group_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"group_id" uuid NOT NULL,
	"subject_user_id" uuid,
	"note" text NOT NULL,
	"kind" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_group_id" text NOT NULL,
	"name" text,
	"organizer_user_id" uuid,
	"added_by_user_id" uuid,
	"created_by_nod" boolean DEFAULT false NOT NULL,
	"spend_rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"joined_at" timestamp with time zone,
	"intro_sent_at" timestamp with time zone,
	"unsupported_at" timestamp with time zone,
	"timezone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"issued_by_user_id" uuid,
	"redeemed_by_user_id" uuid,
	"source" text NOT NULL,
	"event_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	CONSTRAINT "invites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"group_id" uuid NOT NULL,
	"payer_user_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"description" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text,
	"receipt_id" uuid,
	"created_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_shares" (
	"entry_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	CONSTRAINT "ledger_shares_entry_id_user_id_pk" PRIMARY KEY("entry_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"group_id" uuid,
	"dm_user_id" uuid,
	"sender_user_id" uuid,
	"from_nod" boolean DEFAULT false NOT NULL,
	"text" text,
	"media_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service" "service" NOT NULL,
	"reply_to_provider_message_id" text,
	"reactions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"addressed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"group_id" uuid NOT NULL,
	"kind" "option_kind" NOT NULL,
	"source" "option_source" NOT NULL,
	"url" text NOT NULL,
	"parsed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"posted_by_user_id" uuid,
	"provider_message_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_approvals" (
	"collection_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_approvals_collection_id_user_id_pk" PRIMARY KEY("collection_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "payment_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"decision_id" uuid,
	"payee_user_id" uuid NOT NULL,
	"description" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" "collection_status" NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"approval" jsonb NOT NULL,
	"message_id" text,
	"reminder_sent_at" timestamp with time zone,
	"purpose" text DEFAULT 'request' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"token" text NOT NULL,
	"stripe_payment_intent_id" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"status" "payment_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "payment_requests_token_unique" UNIQUE("token"),
	CONSTRAINT "payment_requests_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id")
);
--> statement-breakpoint
CREATE TABLE "pending_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"asked_user_id" uuid NOT NULL,
	"nod_provider_message_id" text NOT NULL,
	"question" text NOT NULL,
	"remaining" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid,
	"image_url" text NOT NULL,
	"parsed" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid,
	"requested_by_user_id" uuid,
	"query" text NOT NULL,
	"location" text,
	"when_text" text,
	"results" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_contacts" (
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_contacts_owner_user_id_phone_pk" PRIMARY KEY("owner_user_id","phone")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"stripe_customer_id" text,
	"stripe_account_id" text,
	"stripe_account_ready" boolean DEFAULT false NOT NULL,
	"payout_token" text,
	"access_status" "access_status" DEFAULT 'waitlist' NOT NULL,
	"invites_remaining" integer DEFAULT 0 NOT NULL,
	"setup_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_payout_token_unique" UNIQUE("payout_token")
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"decision_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"value" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "votes_decision_id_user_id_pk" PRIMARY KEY("decision_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "waitlist" (
	"phone" text PRIMARY KEY NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"notified_at" timestamp with time zone,
	"failed_codes" integer DEFAULT 0 NOT NULL,
	"failed_since" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "booking_approvals" ADD CONSTRAINT "booking_approvals_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_approvals" ADD CONSTRAINT "booking_approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_option_id_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_holder_user_id_users_id_fk" FOREIGN KEY ("holder_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_booked_by_user_id_users_id_fk" FOREIGN KEY ("booked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_poll_choices" ADD CONSTRAINT "date_poll_choices_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_poll_responses" ADD CONSTRAINT "date_poll_responses_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "date_poll_responses" ADD CONSTRAINT "date_poll_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_options" ADD CONSTRAINT "decision_options_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_options" ADD CONSTRAINT "decision_options_option_id_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_winning_option_id_options_id_fk" FOREIGN KEY ("winning_option_id") REFERENCES "public"."options"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_tie_break_user_id_users_id_fk" FOREIGN KEY ("tie_break_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_notes" ADD CONSTRAINT "group_notes_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_notes" ADD CONSTRAINT "group_notes_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_notes" ADD CONSTRAINT "group_notes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_organizer_user_id_users_id_fk" FOREIGN KEY ("organizer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_redeemed_by_user_id_users_id_fk" FOREIGN KEY ("redeemed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_shares" ADD CONSTRAINT "ledger_shares_entry_id_ledger_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."ledger_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_shares" ADD CONSTRAINT "ledger_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_dm_user_id_users_id_fk" FOREIGN KEY ("dm_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "options" ADD CONSTRAINT "options_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "options" ADD CONSTRAINT "options_posted_by_user_id_users_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_approvals" ADD CONSTRAINT "payment_approvals_collection_id_payment_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."payment_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_approvals" ADD CONSTRAINT "payment_approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_collections" ADD CONSTRAINT "payment_collections_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_collections" ADD CONSTRAINT "payment_collections_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_collections" ADD CONSTRAINT "payment_collections_payee_user_id_users_id_fk" FOREIGN KEY ("payee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_collection_id_payment_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."payment_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_questions" ADD CONSTRAINT "pending_questions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_questions" ADD CONSTRAINT "pending_questions_asked_user_id_users_id_fk" FOREIGN KEY ("asked_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "searches" ADD CONSTRAINT "searches_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "searches" ADD CONSTRAINT "searches_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_contacts" ADD CONSTRAINT "user_contacts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_option_id_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_group_idx" ON "bookings" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE INDEX "date_poll_choices_message_idx" ON "date_poll_choices" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "decision_options_message_idx" ON "decision_options" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "decisions_group_status_idx" ON "decisions" USING btree ("group_id","status");--> statement-breakpoint
CREATE INDEX "group_notes_group_idx" ON "group_notes" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_provider_group_idx" ON "groups" USING btree ("provider","provider_group_id");--> statement-breakpoint
CREATE INDEX "invites_issued_by_idx" ON "invites" USING btree ("issued_by_user_id");--> statement-breakpoint
CREATE INDEX "ledger_group_idx" ON "ledger_entries" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_source_idx" ON "ledger_entries" USING btree ("group_id","source","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_message_idx" ON "messages" USING btree ("provider","provider_message_id");--> statement-breakpoint
CREATE INDEX "messages_group_created_idx" ON "messages" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_dm_created_idx" ON "messages" USING btree ("dm_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "options_group_url_idx" ON "options" USING btree ("group_id","url");--> statement-breakpoint
CREATE INDEX "payment_collections_group_idx" ON "payment_collections" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_requests_person_idx" ON "payment_requests" USING btree ("collection_id","user_id");--> statement-breakpoint
CREATE INDEX "pending_questions_lookup_idx" ON "pending_questions" USING btree ("group_id","asked_user_id","created_at");--> statement-breakpoint
CREATE INDEX "searches_group_created_idx" ON "searches" USING btree ("group_id","created_at");