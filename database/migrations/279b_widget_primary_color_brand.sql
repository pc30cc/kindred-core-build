-- 279b — widget_settings.primary_color: NULL is "Brand colour", and the
-- column holds only a colour the widget draws, #RRGGBB.
--
-- What it fixes: every row was seeded with #3B82F6 (002), the colour the
-- widget reads as "uncustomised" (public/widget/loader.js kitBrandColor,
-- presentation-t1/t2 accentTokens): visitors get the brand's colour on the
-- button and in t1/t2, while Widget → Appearance showed the blue swatch as
-- chosen. The panel now offers "Brand colour" as its own choice and stores it
-- as NULL; PATCH /api/widget-settings/:id stores a save of #3B82F6 as NULL
-- and refuses anything but #RRGGBB (shared/widgetColor.ts), and GET /config
-- sends only #RRGGBB (widgetWireColor). Migration 251 changed the column
-- default to #6D5DFB on databases that ran it, so new rows there got a
-- colour nobody chose either.
--
-- Before this release the PATCH took any text up to 32 characters, and the
-- default template drew it as typed (loader.js set --gs-primary to it): a
-- CSS name ("red"), rgb()/hsl(), or #RRGGBBAA showed on the default
-- template (t1/t2 drew the brand colour for anything but hex). So this file
-- converts what a browser could draw instead of dropping it:
--
-- 0. widget_settings.primary_color is read by pg_temp.widget_color_279b(),
--    a function of this session only (gone when it ends):
--      - #RRGGBB is kept as written (spaces trimmed); #RGB becomes #RRGGBB;
--        #RRGGBBAA and #RGBA lose their alpha;
--      - rgb()/rgba() (numbers or percentages, comma or space syntax) and
--        hsl()/hsla() (deg, rad, grad, turn) become the #RRGGBB they draw,
--        their alpha dropped;
--      - the 148 CSS colour names (any case) become their #RRGGBB;
--      - a fully transparent colour (alpha 0, "transparent"), anything a
--        browser cannot draw ("#12", "", "currentColor") and the seeded
--        #3B82F6 (however written) become NULL: the brand colour, which is
--        what visitors already saw for them on the button and in t1/t2.
-- 1. A copy of every value it changes, before it changes it:
--    public.widget_primary_color_backup_279b (workspace_id, primary_color =
--    the value before, new_color = what this file wrote, backed_up_at).
--    Server-only (RLS on, nothing for PUBLIC, anon or authenticated). The
--    first copy is kept if the file runs again. To put the old values back
--    (where nobody has changed the colour since):
--      UPDATE public.widget_settings w
--         SET primary_color = b.primary_color
--        FROM public.widget_primary_color_backup_279b b
--       WHERE w.workspace_id = b.workspace_id
--         AND w.primary_color IS NOT DISTINCT FROM b.new_color;
--    (one workspace: add AND w.workspace_id = '<uuid>'). The table can be
--    dropped once the owner is satisfied; nothing reads it.
-- 2. The rows get their converted values. A real #RRGGBB (and #6D5DFB) is
--    kept as it is.
-- 3. The column default becomes NULL, so a new workspace starts on the
--    brand colour. Rows already on #6D5DFB keep it: they have shown that
--    colour since they were created (count them before deciding otherwise).
--
-- Pre-check (what 1. and 2. will touch):
--   SELECT primary_color, count(*) FROM public.widget_settings GROUP BY 1;
--   SELECT workspace_id, primary_color FROM public.widget_settings
--    WHERE primary_color IS NOT NULL AND primary_color !~ '^#[0-9A-Fa-f]{6}$';
--
-- Locks: the new table is created empty; the INSERT and the UPDATE take ROW
-- EXCLUSIVE on widget_settings (readers and other writers pass) and row
-- locks on the rows they rewrite (one row per workspace, only those that
-- need it); the default is metadata only (ACCESS EXCLUSIVE for an instant)
-- and is dropped only while one is set, so a second run takes no lock but the
-- UPDATE's (which then matches nothing). updated_at is not touched. The file
-- sets lock_timeout 5s itself (RESPOK's migrator runs without PGOPTIONS); a
-- statement stopped by it is simply run again. Dry run: the file inside
-- BEGIN … ROLLBACK. Drops nothing; touches no archive schema or table.

SET lock_timeout = '5s';

-- ─── 0. What a stored value draws, as #RRGGBB (NULL: the brand colour) ───
CREATE OR REPLACE FUNCTION pg_temp.widget_color_279b(v text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $fn_color$
DECLARE
  t text := lower(btrim(coalesce(v, '')));
  num constant text := '[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)';
  parts text[];
  m text[];
  ch numeric[] := ARRAY[0, 0, 0]::numeric[];
  n numeric;
  h numeric;
  s numeric;
  l numeric;
  c numeric;
  x numeric;
  hp numeric;
  lo numeric;
  out text;
BEGIN
  IF t = '' THEN
    RETURN NULL;
  ELSIF t ~ '^#[0-9a-f]{6}$' THEN
    out := btrim(v);
  ELSIF t ~ '^#[0-9a-f]{8}$' THEN
    out := CASE WHEN substr(t, 8, 2) = '00' THEN NULL ELSE upper(substr(t, 1, 7)) END;
  ELSIF t ~ '^#[0-9a-f]{3,4}$' THEN
    out := CASE WHEN length(t) = 5 AND substr(t, 5, 1) = '0' THEN NULL
                ELSE upper('#' || repeat(substr(t, 2, 1), 2) || repeat(substr(t, 3, 1), 2) || repeat(substr(t, 4, 1), 2)) END;
  ELSIF t ~ '^(rgb|hsl)a?\(.*\)$' THEN
    parts := regexp_split_to_array(btrim(regexp_replace(substring(t FROM '^[a-z]+\((.*)\)$'), '[,/]', ' ', 'g')), '\s+');
    IF coalesce(array_length(parts, 1), 0) NOT IN (3, 4) THEN RETURN NULL; END IF;
    IF array_length(parts, 1) = 4 THEN
      IF parts[4] !~ ('^' || num || '%?$') THEN RETURN NULL; END IF;
      IF rtrim(parts[4], '%')::numeric <= 0 THEN RETURN NULL; END IF;
    END IF;
    IF t LIKE 'rgb%' THEN
      FOR i IN 1..3 LOOP
        IF parts[i] ~ ('^' || num || '%$') THEN
          n := rtrim(parts[i], '%')::numeric * 255 / 100;
        ELSIF parts[i] ~ ('^' || num || '$') THEN
          n := parts[i]::numeric;
        ELSE
          RETURN NULL;
        END IF;
        ch[i] := least(255, greatest(0, round(n)));
      END LOOP;
    ELSE
      m := regexp_match(parts[1], '^(' || num || ')(deg|rad|grad|turn)?$');
      IF m IS NULL OR parts[2] !~ ('^' || num || '%?$') OR parts[3] !~ ('^' || num || '%?$') THEN RETURN NULL; END IF;
      h := m[1]::numeric * CASE m[4] WHEN 'rad' THEN (180 / pi())::numeric WHEN 'grad' THEN 0.9 WHEN 'turn' THEN 360 ELSE 1 END;
      h := mod(mod(h, 360) + 360, 360);
      s := least(1, greatest(0, rtrim(parts[2], '%')::numeric / 100));
      l := least(1, greatest(0, rtrim(parts[3], '%')::numeric / 100));
      c := (1 - abs(2 * l - 1)) * s;
      hp := h / 60;
      x := c * (1 - abs(mod(hp, 2) - 1));
      lo := l - c / 2;
      ch := CASE
        WHEN hp < 1 THEN ARRAY[c, x, 0]
        WHEN hp < 2 THEN ARRAY[x, c, 0]
        WHEN hp < 3 THEN ARRAY[0, c, x]
        WHEN hp < 4 THEN ARRAY[0, x, c]
        WHEN hp < 5 THEN ARRAY[x, 0, c]
        ELSE ARRAY[c, 0, x]
      END;
      FOR i IN 1..3 LOOP
        ch[i] := least(255, greatest(0, round((ch[i] + lo) * 255)));
      END LOOP;
    END IF;
    out := '#' || upper(lpad(to_hex(ch[1]::int), 2, '0') || lpad(to_hex(ch[2]::int), 2, '0') || lpad(to_hex(ch[3]::int), 2, '0'));
  ELSE
    SELECT k.hex INTO out FROM (VALUES
        ('aliceblue','#F0F8FF'), ('antiquewhite','#FAEBD7'), ('aqua','#00FFFF'),
        ('aquamarine','#7FFFD4'), ('azure','#F0FFFF'), ('beige','#F5F5DC'), ('bisque','#FFE4C4'),
        ('black','#000000'), ('blanchedalmond','#FFEBCD'), ('blue','#0000FF'),
        ('blueviolet','#8A2BE2'), ('brown','#A52A2A'), ('burlywood','#DEB887'),
        ('cadetblue','#5F9EA0'), ('chartreuse','#7FFF00'), ('chocolate','#D2691E'),
        ('coral','#FF7F50'), ('cornflowerblue','#6495ED'), ('cornsilk','#FFF8DC'),
        ('crimson','#DC143C'), ('cyan','#00FFFF'), ('darkblue','#00008B'), ('darkcyan','#008B8B'),
        ('darkgoldenrod','#B8860B'), ('darkgray','#A9A9A9'), ('darkgreen','#006400'),
        ('darkgrey','#A9A9A9'), ('darkkhaki','#BDB76B'), ('darkmagenta','#8B008B'),
        ('darkolivegreen','#556B2F'), ('darkorange','#FF8C00'), ('darkorchid','#9932CC'),
        ('darkred','#8B0000'), ('darksalmon','#E9967A'), ('darkseagreen','#8FBC8F'),
        ('darkslateblue','#483D8B'), ('darkslategray','#2F4F4F'), ('darkslategrey','#2F4F4F'),
        ('darkturquoise','#00CED1'), ('darkviolet','#9400D3'), ('deeppink','#FF1493'),
        ('deepskyblue','#00BFFF'), ('dimgray','#696969'), ('dimgrey','#696969'),
        ('dodgerblue','#1E90FF'), ('firebrick','#B22222'), ('floralwhite','#FFFAF0'),
        ('forestgreen','#228B22'), ('fuchsia','#FF00FF'), ('gainsboro','#DCDCDC'),
        ('ghostwhite','#F8F8FF'), ('gold','#FFD700'), ('goldenrod','#DAA520'), ('gray','#808080'),
        ('green','#008000'), ('greenyellow','#ADFF2F'), ('grey','#808080'), ('honeydew','#F0FFF0'),
        ('hotpink','#FF69B4'), ('indianred','#CD5C5C'), ('indigo','#4B0082'), ('ivory','#FFFFF0'),
        ('khaki','#F0E68C'), ('lavender','#E6E6FA'), ('lavenderblush','#FFF0F5'),
        ('lawngreen','#7CFC00'), ('lemonchiffon','#FFFACD'), ('lightblue','#ADD8E6'),
        ('lightcoral','#F08080'), ('lightcyan','#E0FFFF'), ('lightgoldenrodyellow','#FAFAD2'),
        ('lightgray','#D3D3D3'), ('lightgreen','#90EE90'), ('lightgrey','#D3D3D3'),
        ('lightpink','#FFB6C1'), ('lightsalmon','#FFA07A'), ('lightseagreen','#20B2AA'),
        ('lightskyblue','#87CEFA'), ('lightslategray','#778899'), ('lightslategrey','#778899'),
        ('lightsteelblue','#B0C4DE'), ('lightyellow','#FFFFE0'), ('lime','#00FF00'),
        ('limegreen','#32CD32'), ('linen','#FAF0E6'), ('magenta','#FF00FF'), ('maroon','#800000'),
        ('mediumaquamarine','#66CDAA'), ('mediumblue','#0000CD'), ('mediumorchid','#BA55D3'),
        ('mediumpurple','#9370DB'), ('mediumseagreen','#3CB371'), ('mediumslateblue','#7B68EE'),
        ('mediumspringgreen','#00FA9A'), ('mediumturquoise','#48D1CC'), ('mediumvioletred','#C71585'),
        ('midnightblue','#191970'), ('mintcream','#F5FFFA'), ('mistyrose','#FFE4E1'),
        ('moccasin','#FFE4B5'), ('navajowhite','#FFDEAD'), ('navy','#000080'), ('oldlace','#FDF5E6'),
        ('olive','#808000'), ('olivedrab','#6B8E23'), ('orange','#FFA500'), ('orangered','#FF4500'),
        ('orchid','#DA70D6'), ('palegoldenrod','#EEE8AA'), ('palegreen','#98FB98'),
        ('paleturquoise','#AFEEEE'), ('palevioletred','#DB7093'), ('papayawhip','#FFEFD5'),
        ('peachpuff','#FFDAB9'), ('peru','#CD853F'), ('pink','#FFC0CB'), ('plum','#DDA0DD'),
        ('powderblue','#B0E0E6'), ('purple','#800080'), ('rebeccapurple','#663399'), ('red','#FF0000'),
        ('rosybrown','#BC8F8F'), ('royalblue','#4169E1'), ('saddlebrown','#8B4513'),
        ('salmon','#FA8072'), ('sandybrown','#F4A460'), ('seagreen','#2E8B57'), ('seashell','#FFF5EE'),
        ('sienna','#A0522D'), ('silver','#C0C0C0'), ('skyblue','#87CEEB'), ('slateblue','#6A5ACD'),
        ('slategray','#708090'), ('slategrey','#708090'), ('snow','#FFFAFA'),
        ('springgreen','#00FF7F'), ('steelblue','#4682B4'), ('tan','#D2B48C'), ('teal','#008080'),
        ('thistle','#D8BFD8'), ('tomato','#FF6347'), ('turquoise','#40E0D0'), ('violet','#EE82EE'),
        ('wheat','#F5DEB3'), ('white','#FFFFFF'), ('whitesmoke','#F5F5F5'), ('yellow','#FFFF00'),
        ('yellowgreen','#9ACD32')
    ) AS k(name, hex)
     WHERE k.name = t;
  END IF;
  IF out IS NULL OR upper(out) = '#3B82F6' THEN
    RETURN NULL;
  END IF;
  RETURN out;
END;
$fn_color$;

-- ─── 1. A copy of every value this file changes ───────────────────────────
CREATE TABLE IF NOT EXISTS public.widget_primary_color_backup_279b (
  workspace_id  uuid PRIMARY KEY,
  primary_color text NOT NULL,
  new_color     text,
  backed_up_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.widget_primary_color_backup_279b IS
  'widget_settings.primary_color as it was before migration 279b converted it (primary_color) and what 279b wrote (new_color; NULL = the brand colour). The restore statement is in 279b''s header. Nothing reads it; drop it once the owner is satisfied. Server-only.';

DO $acl$
BEGIN
  ALTER TABLE public.widget_primary_color_backup_279b ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.widget_primary_color_backup_279b FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.widget_primary_color_backup_279b FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.widget_primary_color_backup_279b FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON public.widget_primary_color_backup_279b TO service_role;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'widget_primary_color_backup_279b' AND policyname = 'service_role_only'
    ) THEN
      CREATE POLICY service_role_only ON public.widget_primary_color_backup_279b
        FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
  END IF;
END $acl$;

INSERT INTO public.widget_primary_color_backup_279b (workspace_id, primary_color, new_color)
SELECT w.workspace_id, w.primary_color, pg_temp.widget_color_279b(w.primary_color)
  FROM public.widget_settings w
 WHERE w.primary_color IS NOT NULL
   AND w.primary_color IS DISTINCT FROM pg_temp.widget_color_279b(w.primary_color)
ON CONFLICT (workspace_id) DO NOTHING;

-- ─── 2. The colour each row draws, or the brand colour ────────────────────
UPDATE public.widget_settings w
   SET primary_color = pg_temp.widget_color_279b(w.primary_color)
 WHERE w.primary_color IS NOT NULL
   AND w.primary_color IS DISTINCT FROM pg_temp.widget_color_279b(w.primary_color);

-- ─── 3. A new workspace starts on the brand colour ────────────────────────
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
  'The widget colour, #RRGGBB, or NULL for the brand colour (shared/widgetColor.ts). Written by PATCH /api/widget-settings/:id, which stores #3B82F6 (the colour the widget reads as uncustomised) as NULL. The values before migration 279b converted them: widget_primary_color_backup_279b.';

RESET lock_timeout;
