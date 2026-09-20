CREATE TABLE "organization_email_domains" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"provider_domain_id" text NOT NULL,
	"status" text DEFAULT 'not_started' NOT NULL,
	"records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"from_name" text NOT NULL,
	"from_local_part" text DEFAULT 'scheduling' NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_email_domains_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
ALTER TABLE "organization_email_domains" ADD CONSTRAINT "organization_email_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;