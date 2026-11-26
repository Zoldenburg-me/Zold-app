-- One issued number per organisation (§14 Abs. 4 Nr. 4 UStG; design §2,
-- invoice numbers). Partial: drafts and supplier invoices carry no issued
-- number. Replaces the plain index from 0001.
DROP INDEX invoices_org_number;
CREATE UNIQUE INDEX invoices_org_number ON invoices (org_id, number) WHERE number IS NOT NULL;
