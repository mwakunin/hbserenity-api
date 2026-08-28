-- A refund record removes its payment from the attention list, so a record
-- without a reference would let an *intention* to refund clear a real debt —
-- money that was never actually returned would vanish from the queue.
--
-- Safe as a direct SET NOT NULL: refunds ship in the same change that adds
-- this, so no row can predate it.
ALTER TABLE "refunds" ALTER COLUMN "mpesa_reference" SET NOT NULL;
