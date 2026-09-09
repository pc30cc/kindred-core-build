/**
 * Default topic catalog seeded on first use.
 * Multilingual: includes fa / tr / en synonyms in keywords + examples.
 */
import type { TopicAction } from './types.js';

export interface DefaultTopic {
  name: string;
  slug: string;
  description: string;
  keywords: string[];
  examples: string[];
  action: TopicAction;
  confidence_threshold?: number;
}

export const DEFAULT_TOPICS: DefaultTopic[] = [
  {
    name: 'Pricing',
    slug: 'pricing',
    description: 'Visitor asks about prices, plans, or cost.',
    keywords: [
      'price','pricing','cost','plan','plans','subscription','tier','quote',
      'fiyat','ücret','ücretler','ücretlendirme','paket','plan','abonelik',
      'قیمت','قیمت‌ها','قیمتها','هزینه','پلن','اشتراک','تعرفه','نرخ',
    ],
    examples: [
      'How much does it cost?', 'What are your plans?', 'pricing page',
      'fiyat nedir', 'plan fiyatı', 'ne kadar?',
      'قیمت پلن چنده؟', 'هزینه اشتراک چقدر است؟', 'تعرفه شما چیست؟',
    ],
    action: 'route',
  },
  {
    name: 'Sales',
    slug: 'sales',
    description: 'Visitor wants to talk to sales or buy.',
    keywords: [
      'buy','purchase','demo','sales','enterprise','contract','invoice',
      'satın','satın al','satış','demo','kurumsal',
      'خرید','خرید کنم','فروش','دمو','تماس با فروش','سازمانی',
    ],
    examples: [
      'I want to buy', 'book a demo', 'talk to sales',
      'satın almak istiyorum', 'demo görmek istiyorum',
      'میخوام بخرم', 'دمو میخوام', 'با فروش صحبت کنم',
    ],
    action: 'route',
  },
  {
    name: 'Support',
    slug: 'support',
    description: 'General product support / help / how-to.',
    keywords: [
      'help','support','how to','question','assist',
      'yardım','destek','nasıl','soru',
      'کمک','پشتیبانی','چطور','چگونه','سوال','راهنمایی',
    ],
    examples: [
      'I need help', 'how do I…', 'support please',
      'yardım lazım', 'nasıl yapılır',
      'کمک میخوام', 'چطور میشه', 'راهنمایی میخوام',
    ],
    action: 'label_only',
  },
  {
    name: 'Billing',
    slug: 'billing',
    description: 'Invoices, payment methods, payment failures.',
    keywords: [
      'invoice','billing','payment','charge','card','refund','vat',
      'fatura','ödeme','iade','kart',
      'فاکتور','صورتحساب','پرداخت','بازپرداخت','کارت','بانک',
    ],
    examples: [
      'invoice issue', 'payment failed', 'refund my card',
      'fatura sorunu', 'ödeme başarısız',
      'فاکتور نمیاد', 'پرداخت نشد', 'پولم برگرده',
    ],
    action: 'route',
  },
  {
    name: 'Technical issue',
    slug: 'technical-issue',
    description: 'Bug, error, broken feature, integration not working.',
    keywords: [
      'error','bug','broken','crash','not working','issue','problem',
      'hata','sorun','çalışmıyor','bozuk',
      'خطا','ارور','مشکل','کار نمی‌کند','کار نمیکنه','خراب','مشکل دارم',
    ],
    examples: [
      "I'm getting an error", 'bug in the widget', 'crash on login',
      'hata alıyorum', 'çalışmıyor',
      'خطا دارم', 'مشکل دارم', 'باز نمی‌شود',
    ],
    action: 'label_only',
  },
  {
    name: 'Human request',
    slug: 'human-request',
    description: 'Visitor explicitly wants to talk to a human operator.',
    keywords: [
      'human','operator','agent','real person','representative','someone',
      'insan','operatör','temsilci','gerçek kişi','canlı destek',
      'اپراتور','انسان','آدم','نماینده','شخص واقعی','پشتیبان انسانی',
    ],
    examples: [
      'talk to a human', 'connect me to an operator', 'real person please',
      'operatör istiyorum', 'gerçek bir insanla konuşmak istiyorum', 'canlı destek',
      'اپراتور میخوام', 'با آدم صحبت کنم', 'وصل کن به پشتیبان',
    ],
    action: 'route',
    confidence_threshold: 0.5,
  },
  {
    name: 'Greeting',
    slug: 'greeting',
    description: 'Hello / hi / opening message with no intent yet.',
    keywords: [
      'hi','hello','hey','greetings','good morning','good evening',
      'merhaba','selam','iyi günler','iyi akşamlar',
      'سلام','درود','صبح بخیر','عصر بخیر','شب بخیر',
    ],
    examples: [
      'hi', 'hello there', 'hey',
      'merhaba', 'selam',
      'سلام', 'درود',
    ],
    action: 'label_only',
  },
  {
    name: 'Complaint',
    slug: 'complaint',
    description: 'Negative feedback or complaint.',
    keywords: [
      'complaint','unhappy','disappointed','bad service','terrible','worst',
      'şikayet','memnun değil','kötü hizmet','berbat',
      'شکایت','ناراضی','بد','افتضاح','خراب','شکایت دارم',
    ],
    examples: [
      'I want to file a complaint', 'this service is bad',
      'şikayetim var', 'hizmet kötü',
      'شکایت دارم', 'سرویس بد است',
    ],
    action: 'route',
  },
  {
    name: 'Cancellation / refund',
    slug: 'cancellation-refund',
    description: 'Cancel subscription or request refund.',
    keywords: [
      'cancel','cancellation','refund','unsubscribe','close account',
      'iptal','iade','abonelik iptal','hesap kapat',
      'لغو','کنسل','بازپرداخت','استرداد','لغو اشتراک','حساب رو ببند',
    ],
    examples: [
      'cancel my subscription', 'I want a refund',
      'aboneliği iptal et', 'iade istiyorum',
      'اشتراکم رو لغو کن', 'پولم رو پس بدید',
    ],
    action: 'route',
  },
  {
    name: 'Demo request',
    slug: 'demo-request',
    description: 'Visitor wants a product demo.',
    keywords: [
      'demo','walkthrough','show me','presentation',
      'demo','tanıtım','göster',
      'دمو','نمایش','معرفی محصول','نشونم بده',
    ],
    examples: [
      'can I see a demo?', 'book a walkthrough',
      'demo görebilir miyim',
      'دمو میخوام', 'یه نمایش بدید',
    ],
    action: 'route',
  },
  {
    name: 'Off-topic',
    slug: 'off-topic',
    description: 'Politics, war, religion or other subjects unrelated to the business. When matched, the assistant declines with a fixed reply instead of answering — see action: "decline".',
    keywords: [
      'war','politics','political','election','president','government','religion','religious',
      'savaş','siyaset','siyasi','seçim','başkan','hükümet','din','dini','mezhep',
      'جنگ','سیاست','سیاسی','انتخابات','رئیس‌جمهور','دولت','مذهب','دینی','مذهبی','جنگی',
    ],
    examples: [
      'who do you support in the election', 'what do you think about the war', 'is god real',
      'savaş ne zaman biter', 'kimi destekliyorsun', 'hangi partiye oy vermeliyim',
      'جنگ ایران و آمریکا کی تموم میشه', 'نظرت راجب سیاست چیه', 'به کی رای بدم', 'دین بهتر کدومه',
    ],
    action: 'decline',
    confidence_threshold: 0.5,
  },
];