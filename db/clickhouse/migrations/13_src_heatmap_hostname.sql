-- Fork-local column: the src_ prefix keeps this clear of any hostname column
-- upstream may add to heatmap_event later. '' means unknown (rows recorded
-- before this migration); such rows are excluded when a hostname filter is
-- active and age out of the reporting window.
ALTER TABLE umami.heatmap_event
    ADD COLUMN IF NOT EXISTS src_hostname LowCardinality(String) DEFAULT '';
