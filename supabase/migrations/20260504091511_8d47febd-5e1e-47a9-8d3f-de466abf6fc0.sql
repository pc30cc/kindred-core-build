
DO $$
DECLARE
  ws uuid := '6ee40d07-32a3-4594-8a5f-d439f81afa5b';
BEGIN

-- Production-specific AI agent seed for a hosted tenant. On a pristine
-- local/reset database that workspace does not exist, so this optional
-- operational configuration is skipped cleanly instead of violating the
-- workspace_id foreign keys below.
IF NOT EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id = ws) THEN
  RETURN;
END IF;

UPDATE ai_agent_settings SET
  agent_name = 'Destekly Asistan',
  business_description = 'Destekly, küçük ve orta ölçekli işletmeler için tasarlanmış bir müşteri destek platformudur. Canlı sohbet widget''ı, AI agent, sesli/görüntülü görüşme, bilgi tabanı, ziyaretçi takibi ve operatör paneli sunar. Web sitemiz: https://destekly.tr',
  welcome_message = 'Merhaba! Destekly''ye hoş geldiniz. Size nasıl yardımcı olabilirim?',
  intro_message = 'Ben Destekly''nin AI asistanıyım. Fiyatlandırma, kurulum, özellikler ve teknik konularda yardımcı olabilirim. Bir insana bağlanmak isterseniz "operatör" yazmanız yeterli.',
  fallback_message = 'Bu konuda emin değilim. Sizi bir destek temsilcimize bağlıyorum.',
  mode = 'auto_reply_until_human_joins',
  enabled = true,
  answer_only_from_kb = false,
  confidence_threshold = 0.55,
  handoff_on_low_confidence = true,
  handoff_on_human_request = true,
  handoff_when_no_kb_match = false,
  allowed_locales = ARRAY['tr','en','fa'],
  instructions = jsonb_build_object(
    'brand_voice','Profesyonel, samimi, kısa ve net. Asla satıcı gibi davranma; danışman gibi konuş.',
    'tone','friendly_professional',
    'do_list', jsonb_build_array(
      'Ziyaretçinin yazdığı dilde cevap ver (Türkçe sorulursa Türkçe).',
      'Cevapları kısa, madde madde ve eyleme yönelik tut.',
      'Fiyat veya plan sorularında yalnızca onaylı bilgi tabanından alıntı yap.',
      'Emin olmadığında "emin değilim" de ve operatöre devret.',
      'Müşteriyi her zaman doğru kaynağa (yardım sayfası, fiyatlandırma) yönlendir.'
    ),
    'dont_list', jsonb_build_array(
      'Asla bilgi tabanında olmayan fiyat, indirim veya tarih uydurma.',
      'Rakipleri kötüleme.',
      'Yasal, tıbbi veya finansal tavsiye verme.',
      'Müşteri verilerini, e-posta veya kart bilgisini sohbette tekrar etme.',
      'Uzun, jenerik pazarlama metni yazma.'
    ),
    'pricing_instructions','Tüm fiyat soruları için yalnızca Q&A''daki Destekly planlarına dayan: Free, Starter (₺299/ay), Pro (₺799/ay), Business (₺1999/ay). Yıllık ödemede %20 indirim. Özel kurumsal fiyat için satışa yönlendir: sales@destekly.tr',
    'support_instructions','Teknik hatalar için önce sürüm/tarayıcı sor, sonra docs.destekly.tr''ye yönlendir. Çözülemeyen vakaları operatöre devret.',
    'handoff_instructions','Ziyaretçi "operatör", "insan", "yetkili", "temsilci" derse veya 2 deneme sonra hâlâ tatmin olmamışsa hemen devret. Devretmeden önce bağlamı kısa özetle.',
    'forbidden_topics', jsonb_build_array('siyaset','din','rakip karşılaştırması'),
    'max_answer_length','medium'
  ),
  updated_at = now()
WHERE workspace_id = ws;

DELETE FROM ai_agent_guidance_rules WHERE workspace_id = ws;
INSERT INTO ai_agent_guidance_rules (workspace_id, title, description, rule_type, instruction, priority, enabled) VALUES
(ws,'Match visitor language','Reply in the language the visitor used.','tone',
 'Detect the visitor''s language from their last message. Reply in the SAME language. Default brand language is Turkish.',10,true),
(ws,'Brand voice','Professional, friendly, concise.','tone',
 'Use a professional yet friendly tone. Keep replies under 4 sentences unless explaining a process. Use bullet points for steps.',20,true),
(ws,'Pricing accuracy','Only quote prices from the approved knowledge base.','pricing_guidance',
 'NEVER invent prices, plans, discounts or dates. If the answer is not in the knowledge base, say you are not sure and offer to connect to sales.',30,true),
(ws,'Escalation policy','When to hand off to a human.','escalation_policy',
 'Hand off when: visitor explicitly asks for a human, topic is billing/refund/contract, two consecutive low-confidence replies, or visitor seems frustrated.',40,true),
(ws,'GDPR / KVKK','Privacy compliance reminder.','answer_policy',
 'If asked how data is used, point to https://destekly.tr/privacy and confirm KVKK + GDPR compliance. Never read personal data back to the visitor.',50,true),
(ws,'Sales motion','How to handle pre-sales questions.','sales_guidance',
 'For sales/demo/enterprise questions: be helpful, summarize relevant features in 2-3 bullets, then offer to connect to sales (sales@destekly.tr) or schedule a demo.',60,true);

DELETE FROM ai_agent_routing_rules WHERE workspace_id = ws;
INSERT INTO ai_agent_routing_rules (workspace_id, name, description, trigger_type, conditions_json, action_type, action_json, priority, enabled) VALUES
(ws,'Human request → handoff','Visitor asked for an operator.','human_request',
 jsonb_build_object('keywords', jsonb_build_array('operatör','insan','yetkili','temsilci','human','agent','operator','اپراتور','انسان')),
 'handoff', jsonb_build_object('reason','human_requested','department','support'),10,true),
(ws,'Billing topic → handoff','Refund / invoice / billing dispute.','topic_detected',
 jsonb_build_object('topic_slugs', jsonb_build_array('billing')),
 'handoff', jsonb_build_object('reason','billing_topic','department','billing'),20,true),
(ws,'No answer → handoff','AI cannot answer after retries.','no_answer',
 jsonb_build_object('max_attempts',2),
 'handoff', jsonb_build_object('reason','no_answer','department','support'),30,true),
(ws,'Low confidence → handoff','Two consecutive low-confidence replies.','low_confidence',
 jsonb_build_object('threshold',0.55,'consecutive',2),
 'handoff', jsonb_build_object('reason','low_confidence','department','support'),40,true);

DELETE FROM ai_agent_topics WHERE workspace_id = ws;
INSERT INTO ai_agent_topics (workspace_id, name, description, slug, keywords, examples, language, confidence_threshold, action, enabled, system) VALUES
(ws,'Fiyatlandırma','Plan, fiyat, indirim, ücret soruları.','pricing',
 ARRAY['fiyat','ücret','plan','paket','abonelik','indirim','price','pricing','cost','ne kadar'],
 ARRAY['Fiyatlarınız nedir?','Aylık ücreti ne kadar?','Hangi planlar var?','Yıllık indirim var mı?'],
 'tr',0.6,'label_only',true,false),
(ws,'Satış','Demo, kurumsal teklif, satış öncesi.','sales',
 ARRAY['demo','satış','kurumsal','teklif','enterprise','sales','özel fiyat'],
 ARRAY['Demo alabilir miyim?','Kurumsal teklif istiyorum.','Satış ekibiyle görüşebilir miyim?'],
 'tr',0.6,'label_only',true,false),
(ws,'Destek','Genel kullanım, nasıl yapılır.','support',
 ARRAY['nasıl','yardım','yardim','help','destek','kurulum','widget','entegrasyon','install'],
 ARRAY['Widget nasıl kurulur?','AI agent nasıl çalışır?','Operatör nasıl eklerim?'],
 'tr',0.55,'label_only',true,false),
(ws,'Faturalama','Fatura, iade, ödeme sorunu.','billing',
 ARRAY['fatura','iade','ödeme','para iadesi','refund','invoice','billing','kart reddedildi'],
 ARRAY['Faturamı nereden indiririm?','Para iadesi mümkün mü?','Kartım reddedildi.'],
 'tr',0.6,'route',true,false),
(ws,'Teknik sorun','Hata, çalışmıyor, çökme.','technical',
 ARRAY['hata','çalışmıyor','bug','crash','error','sorun','açılmıyor','yüklenmiyor'],
 ARRAY['Widget yüklenmiyor.','Sesli görüşme açılmıyor.','Bir hata aldım.'],
 'tr',0.6,'label_only',true,false),
(ws,'İnsan talebi','Operatöre bağlanma isteği.','human-request',
 ARRAY['operatör','insan','yetkili','temsilci','human','agent','operator','اپراتور','انسان'],
 ARRAY['Bir operatörle konuşmak istiyorum.','İnsan bağlanır mısınız?','Yetkili biriyle görüşmek istiyorum.'],
 'tr',0.5,'route',true,true);

DELETE FROM ai_agent_message_triggers WHERE workspace_id = ws;
INSERT INTO ai_agent_message_triggers (workspace_id, name, description, event_type, conditions_json, action_type, action_json, delay_seconds, enabled) VALUES
(ws,'Welcome on first message','Send a friendly intro on the visitor''s first message.','visitor_first_message',
 jsonb_build_object('once_per_conversation',true),
 'send_message',
 jsonb_build_object('message','Merhaba! 👋 Ben Destekly''nin AI asistanıyım. Fiyat, kurulum veya teknik konularda yardımcı olabilirim. Nasıl yardımcı olayım?'),
 0,true),
(ws,'Ask for email after no answer','If AI cannot answer, request email.','ai_no_answer',
 jsonb_build_object('consecutive_low_confidence',2),
 'send_message',
 jsonb_build_object('message','Sorunuzu daha iyi araştırmak istiyorum. E-posta adresinizi bırakırsanız ekibimiz en geç 1 iş günü içinde dönüş yapar.'),
 0,true);

DELETE FROM ai_agent_workflows WHERE workspace_id = ws;
INSERT INTO ai_agent_workflows (workspace_id, name, description, trigger_json, steps_json, enabled, status) VALUES
(ws,'Pricing inquiry → sales handoff',
 'When pricing topic detected with low KB confidence, route to sales.',
 jsonb_build_object('type','topic_detected','topic_slug','pricing','min_confidence',0.6,'low_kb_confidence_below',0.55),
 jsonb_build_array(
   jsonb_build_object('type','send_ai_message','message','Fiyatlarımız hakkında size daha doğru bilgi vermesi için satış ekibimize bağlıyorum. Bir saniye lütfen.'),
   jsonb_build_object('type','handoff','department','sales','reason','pricing_inquiry')
 ),
 true,'active');

DELETE FROM ai_agent_qna WHERE workspace_id = ws;
INSERT INTO ai_agent_qna (workspace_id, question, answer, locale, enabled) VALUES
(ws,'Destekly nedir?','Destekly, KOBİ''ler için tasarlanmış bir müşteri destek platformudur. Canlı sohbet widget''ı, AI agent, sesli/görüntülü görüşme, bilgi tabanı, ziyaretçi takibi ve operatör panelini tek bir yerde sunar. Daha fazla bilgi: https://destekly.tr','tr',true),
(ws,'Hangi planlarınız var?','Dört planımız var: **Free** (1 operatör, 100 sohbet/ay), **Starter** ₺299/ay (3 operatör, AI agent), **Pro** ₺799/ay (10 operatör, sesli/görüntülü görüşme, bilgi tabanı), **Business** ₺1999/ay (sınırsız operatör, gelişmiş yönlendirme, SLA). Yıllık ödemede %20 indirim. Detay: https://destekly.tr/pricing','tr',true),
(ws,'Ücretsiz deneme var mı?','Evet — tüm ücretli planlar için 14 gün ücretsiz deneme sunuyoruz. Kredi kartı gerekmez. https://destekly.tr/signup','tr',true),
(ws,'Widget''ı sitemize nasıl kurarız?','Çok basit: Panelde **Widget → Yükle** sekmesine girin, oradaki tek satırlık script''i sitenizin </body> etiketinden hemen önce yapıştırın. Birkaç saniye içinde çalışır. Detaylı kurulum: https://destekly.tr/docs/install','tr',true),
(ws,'AI agent ne yapıyor?','AI agent; bilgi tabanınızdan ve Q&A''lardan beslenerek ziyaretçi sorularını otomatik yanıtlar, gerektiğinde operatöre devreder, mesai dışı saatlerde mesaj toplar ve operatöre öneriler sunar. Yalnızca onayladığınız içeriklere dayanır.','tr',true),
(ws,'AI agent hangi dilleri destekler?','AI agent şu anda **Türkçe, İngilizce ve Farsça** destekler ve ziyaretçinin yazdığı dilde otomatik cevap verir.','tr',true),
(ws,'Sesli ve görüntülü görüşme var mı?','Evet, **Pro** ve **Business** planlarında dahildir. WebRTC tabanlıdır, ek kurulum gerektirmez ve tarayıcıda çalışır.','tr',true),
(ws,'Operatör eklemenin sınırı var mı?','Free: 1, Starter: 3, Pro: 10, Business: sınırsız. Plan değiştirme anında geçerli olur.','tr',true),
(ws,'Verilerimiz nerede saklanıyor?','Tüm veriler AB bölgesinde (Frankfurt) barındırılır. KVKK ve GDPR uyumluyuz. Detay: https://destekly.tr/privacy','tr',true),
(ws,'İade politikanız nedir?','İlk 14 gün içinde memnun kalmazsanız tam iade yapıyoruz. Sonraki dönem ücretleri için kullanılmamış aylar iade edilir. İade için: billing@destekly.tr','tr',true),
(ws,'Ödeme yöntemleri nelerdir?','Kredi kartı (Visa, Mastercard, Amex), havale/EFT ve kurumsal müşteriler için fatura ile ödeme kabul ediyoruz.','tr',true),
(ws,'Kurumsal teklif alabilir miyim?','Tabii. 50+ operatör, özel SLA veya on-premise için satış ekibimiz size özel teklif hazırlar. İletişim: sales@destekly.tr','tr',true),
(ws,'Mevcut araçlarımızla entegre olur mu?','Slack, Microsoft Teams, WhatsApp Business, e-posta ve webhook entegrasyonlarımız var. CRM tarafında HubSpot ve Salesforce destekleniyor.','tr',true),
(ws,'Mesai dışı sorular ne olur?','AI agent gece/hafta sonu ziyaretçilerin sorularını yanıtlar, çözemediği konularda iletişim bilgilerini toplar ve sabah ekibinize bekleyen liste olarak sunar.','tr',true),
(ws,'Bir operatörle konuşmak istiyorum.','Tabii — sizi hemen bir operatörümüze bağlıyorum. Ortalama yanıt süresi mesai saatlerinde 1 dakikadan azdır.','tr',true);

DELETE FROM ai_agent_sources WHERE workspace_id = ws AND source_type IN ('knowledge_base','qna','integrations');
INSERT INTO ai_agent_sources (workspace_id, source_type, enabled, status, metadata) VALUES
(ws,'knowledge_base',true,'idle','{}'::jsonb),
(ws,'qna',true,'idle','{}'::jsonb),
(ws,'integrations',true,'idle','{}'::jsonb);

END $$;
