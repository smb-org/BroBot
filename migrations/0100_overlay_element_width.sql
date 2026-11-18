ALTER TABLE overlay_elements
  ADD COLUMN width_px INTEGER CHECK (width_px IS NULL OR width_px BETWEEN 80 AND 1920);
