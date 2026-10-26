-- Persist model input capabilities separately from the display metadata.
-- Keep public_info.supportsImages in sync for backwards-compatible clients.
ALTER TABLE model_access_catalog
    ADD COLUMN IF NOT EXISTS supports_images BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE model_access_catalog
SET supports_images = TRUE
WHERE LOWER(COALESCE(public_info->>'supportsImages', 'false')) = 'true';
