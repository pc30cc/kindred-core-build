-- The original demo/onboarding seed (20260504091511_...) hardcoded a
-- Turkish welcome_message/intro_message into ai_agent_settings for the
-- hosted "Destekly" tenant. That legacy single-locale text still wins in
-- buildIntroBody()'s fallback chain whenever a visitor's browser locale
-- isn't covered by intro_message_localized, overriding text the owner
-- sets today in the per-language Settings editor. Clear it at the data
-- layer (targeted by exact value, so this only touches rows still
-- carrying the untouched seed — never a workspace's own custom text) so
-- the chain falls through to intro_message_localized / the built-in
-- per-locale template instead.
UPDATE public.ai_agent_settings
SET intro_message = NULL
WHERE intro_message = 'Ben Destekly''nin AI asistanıyım. Fiyatlandırma, kurulum, özellikler ve teknik konularda yardımcı olabilirim. Bir insana bağlanmak isterseniz "operatör" yazmanız yeterli.';

UPDATE public.ai_agent_settings
SET welcome_message = NULL
WHERE welcome_message = 'Merhaba! Destekly''ye hoş geldiniz. Size nasıl yardımcı olabilirim?';
