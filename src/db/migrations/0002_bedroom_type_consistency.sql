ALTER TABLE "properties" DROP CONSTRAINT "properties_capacity_positive";--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_bedrooms_match_type" CHECK (("properties"."property_type" = 'studio' AND "properties"."bedrooms" = 0)
        OR ("properties"."property_type" <> 'studio' AND "properties"."bedrooms" >= 1));--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_capacity_positive" CHECK ("properties"."max_guests" > 0 AND "properties"."bedrooms" >= 0 AND "properties"."bathrooms" >= 0 AND "properties"."beds" >= 1);