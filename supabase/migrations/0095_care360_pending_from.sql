-- =====================================================================
-- BEMMP · 0095 · Care 360 ticket tracker: the Pending Call - Master's columns
--
-- The user, 28 Nov: the tracker takes the team's Pending Call - Master from column T. Their "Pending From" becomes
-- our Ticket Status, which gains the values it had that we did not: RBER, OEM, Warranty, In Transit and
-- Local Purchase / Service ("Care 360" is our Cyrix). PR No, PR Date, PO No, PO Date and Remarks use the fields the
-- other trackers already have (pr_no, pr_date, po_no, po_date, coordinator_remark), as do the two new dates:
-- Expected call closing date (edc) and Expected delivery date (spare_edd). The history already follows all of them.
-- =====================================================================

alter table meeting_note drop constraint if exists meeting_note_ticket_status_check;
alter table meeting_note add constraint meeting_note_ticket_status_check
  check (ticket_status in ('Completed', 'Customer', 'Cyrix', 'Purchase', 'Revive Lab', 'Under Observation',
                           'RBER', 'OEM', 'Warranty', 'In Transit', 'Local Purchase / Service'));
