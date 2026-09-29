CREATE TYPE "public"."access_status" AS ENUM('waitlist', 'active');--> statement-breakpoint
CREATE TYPE "public"."option_kind" AS ENUM('rental', 'restaurant', 'activity', 'event', 'ticket', 'other');--> statement-breakpoint
CREATE TYPE "public"."option_source" AS ENUM('link', 'search');--> statement-breakpoint
CREATE TYPE "public"."service" AS ENUM('imessage', 'sms');--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"opted_out" boolean DEFAULT false NOT NULL,
	CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"access_status" "access_status" DEFAULT 'waitlist' NOT NULL,
	"invites_remaining" integer DEFAULT 0 NOT NULL,
	"setup_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_organizer_user_id_users_id_fk" FOREIGN KEY ("organizer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_dm_user_id_users_id_fk" FOREIGN KEY ("dm_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "options" ADD CONSTRAINT "options_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "options" ADD CONSTRAINT "options_posted_by_user_id_users_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_questions" ADD CONSTRAINT "pending_questions_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_questions" ADD CONSTRAINT "pending_questions_asked_user_id_users_id_fk" FOREIGN KEY ("asked_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "searches" ADD CONSTRAINT "searches_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "searches" ADD CONSTRAINT "searches_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_contacts" ADD CONSTRAINT "user_contacts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "groups_provider_group_idx" ON "groups" USING btree ("provider","provider_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_message_idx" ON "messages" USING btree ("provider","provider_message_id");--> statement-breakpoint
CREATE INDEX "messages_group_created_idx" ON "messages" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_dm_created_idx" ON "messages" USING btree ("dm_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "options_group_url_idx" ON "options" USING btree ("group_id","url");--> statement-breakpoint
CREATE INDEX "pending_questions_lookup_idx" ON "pending_questions" USING btree ("group_id","asked_user_id","created_at");--> statement-breakpoint
CREATE INDEX "searches_group_created_idx" ON "searches" USING btree ("group_id","created_at");