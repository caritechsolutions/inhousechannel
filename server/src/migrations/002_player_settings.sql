-- Output settings the CMS wants the player to use (address, port, codec, bitrates …).
-- NULL = never set; the box keeps its local conf. output_json stays the read-only mirror
-- of what the box actually reports.
ALTER TABLE players ADD COLUMN settings_json TEXT;
