UPDATE public.conversation_messages AS m
SET body = COALESCE(
  NULLIF(BTRIM(s.intro_message_localized ->> 'fa'), ''),
  NULLIF(BTRIM(s.intro_message), ''),
  NULLIF(BTRIM(s.welcome_message), ''),
  'سلام! من دستیار هوش مصنوعی هستم. چطور می‌توانم کمکتان کنم؟'
)
FROM public.conversations AS c
JOIN public.ai_agent_settings AS s ON s.workspace_id = c.workspace_id
WHERE m.conversation_id = c.id
  AND m.sender_type = 'ai'
  AND m.metadata ->> 'source' = 'ai_agent_intro'
  AND m.body = 'Ben Destekly''nin AI asistanıyım. Fiyatlandırma, kurulum, özellikler ve teknik konularda yardımcı olabilirim. Bir insana bağlanmak isterseniz "operatör" yazmanız yeterli.'
  AND c.workspace_id = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';