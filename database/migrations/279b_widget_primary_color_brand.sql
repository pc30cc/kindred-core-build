-- 279b — widget_settings.primary_color: NULL is "Brand colour", and the
-- column holds only a real colour.
--
-- What it fixes: every row was seeded with #3B82F6 (002), the colour the
-- widget reads as "uncustomised" (public/widget/loader.js kitBrandColor,
-- presentation-t1/t2 accentTokens): visitors get the brand's colour on the
-- button and in t1/t2, while Widget → Appearance showed the blue swatch as
-- chosen. The panel now offers "Brand colour" as its own choice and stores it
-- as NULL; PATCH /api/widget-settings/:id stores a save of #3B82F6 as NULL
-- and refuses anything but #RRGGBB (shared/widgetColor.ts). Migration 251
-- changed the column default to #6D5DFB on databases that ran it, so new
-- rows there got a colour nobody chose either.
--
-- 1. Rows on the seeded #3B82F6 become NULL: the brand colour they already
--    showed on the button and in t1/t2 (the default and intl templates' panel
--    now wears it too, as the kit's button does).
-- 2. A value that is not a colour the widget can draw (a half-typed "#12",
--    a name such as "red") becomes NULL, which is what t1/t2 already drew
--    for it; "#abc" becomes "#AABBCC". A real colour is kept as it is.
-- 3. The column default becomes NULL, so a new workspace starts on the
--    brand colour. Rows already on #6D5DFB keep it: they have shown that
--    colour since they were created (count them before deciding otherwise:
--    SELECT primary_color, count(*) FROM widget_settings GROUP BY 1).
--
-- Locks: the UPDATEs take ROW EXCLUSIVE (readers and other writers pass) and
-- row locks on the rows they rewrite (one row per workspace, only those that
-- need it); the default is metadata only (ACCESS EXCLUSIVE for an instant)
-- and is dropped only while one is set, so a second run takes no lock but the
-- UPDATEs' (which then match nothing). updated_at is not touched: what
-- visitors see on the button is unchanged. The file sets lock_timeout 5s
-- itself (RESPOK's migrator runs without PGOPTIONS); a statement stopped by
-- it is simply run again. Dry run: the file inside BEGIN … ROLLBACK. Drops
-- nothing; touches no archive schema or table.

SET lock_timeout = '5s';

-- 1 and 2. The seed and anything that is not a colour: the brand colour.
UPDATE public.widget_settings
   SET primary_color = NULL
 WHERE primary_color IS NOT NULL
   AND (upper(btrim(primary_color)) = '#3B82F6'
        OR btrim(primary_color) !~ '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$');

UPDATE public.widget_settings
   SET primary_color = upper('#' || substr(btrim(primary_color), 2, 1) || substr(btrim(primary_color), 2, 1)
                            || substr(btrim(primary_color), 3, 1) || substr(btrim(primary_color), 3, 1)
                            || substr(btrim(primary_color), 4, 1) || substr(btrim(primary_color), 4, 1))
 WHERE primary_color ~ '^\s*#[0-9A-Fa-f]{3}\s*$';

-- Spaces around a six-digit colour.
UPDATE public.widget_settings
   SET primary_color = btrim(primary_color)
 WHERE primary_color ~ '^\s+#|#[0-9A-Fa-f]{6}\s+$';

-- 3. A new workspace starts on the brand colour.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_attrdef d
      JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
     WHERE d.adrelid = 'public.widget_settings'::regclass AND a.attname = 'primary_color'
  ) THEN
    ALTER TABLE public.widget_settings ALTER COLUMN primary_color DROP DEFAULT;
  END IF;
END
$$;

COMMENT ON COLUMN public.widget_settings.primary_color IS
  'The widget colour, #RRGGBB, or NULL for the brand colour (shared/widgetColor.ts). Written by PATCH /api/widget-settings/:id, which stores #3B82F6 (the colour the widget reads as uncustomised) as NULL.';
