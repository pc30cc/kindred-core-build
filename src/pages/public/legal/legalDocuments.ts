/**
 * The privacy policy and terms of use, as the public site (webyar.ai/privacy,
 * webyar.ai/terms) publishes them — the Persian word for word, with English
 * and Turkish translations of the same text.
 *
 * Served by the app itself at /privacy and /terms so the iPhone and Android
 * apps, and their store records, can link to a page on the platform's own
 * domain. A change here is a change to a legal text: make it on the site too,
 * and move the effective date.
 */
import type { Locale } from '@/i18n/config';

export type LegalDocumentId = 'privacy' | 'terms';

export interface LegalSection {
  heading: string;
  /** `{email}` stands for the contact address, drawn as a mail link. */
  paragraphs: string[];
}

export interface LegalDocument {
  /** The browser tab's title. */
  pageTitle: string;
  title: string;
  /** The line under the title: when it took effect, and whose it is. */
  effective: string;
  sections: LegalSection[];
}

export interface LegalChrome {
  brand: string;
  copyright: string;
  /** The footer's names for the two documents. */
  privacy: string;
  terms: string;
}

export const LEGAL_CONTACT_EMAIL = 'info@webyar.ai';

/** The order the language switch lists them in. */
export const LEGAL_LOCALES: { locale: Locale; label: string }[] = [
  { locale: 'fa', label: 'فارسی' },
  { locale: 'en', label: 'English' },
  { locale: 'tr', label: 'Türkçe' },
];

/** The site publishes Persian; a path without a language is that. */
export const LEGAL_DEFAULT_LOCALE: Locale = 'fa';

export const LEGAL_CHROME: Record<Locale, LegalChrome> = {
  fa: {
    brand: 'وب‌یار',
    copyright: '© ۱۴۰۵ وب‌یار — تمامی حقوق محفوظ است',
    privacy: 'حریم خصوصی',
    terms: 'شرایط استفاده',
  },
  en: {
    brand: 'Webyar',
    copyright: '© 2026 Webyar — All rights reserved.',
    privacy: 'Privacy',
    terms: 'Terms of Use',
  },
  tr: {
    brand: 'Webyar',
    copyright: '© 2026 Webyar — Tüm hakları saklıdır.',
    privacy: 'Gizlilik',
    terms: 'Kullanım Koşulları',
  },
};

const PRIVACY: Record<Locale, LegalDocument> = {
  fa: {
    pageTitle: 'سیاست حریم خصوصی | وب‌یار',
    title: 'سیاست حریم خصوصی',
    effective: 'تاریخ اجرا: ۱۰ شهریور ۱۴۰۵ · وب‌یار',
    sections: [
      {
        heading: '۱. مقدمه',
        paragraphs: [
          'این سیاست حریم خصوصی توضیح می‌دهد که وب‌یار چگونه هنگام استفاده شما از وب‌سایت، اپلیکیشن‌ها و سرویس‌های مرتبط («سرویس‌ها») اطلاعات شخصی را جمع‌آوری، استفاده، افشا، ذخیره و محافظت می‌کند.',
          'با استفاده از سرویس‌ها، این سیاست را می‌پذیرید. اگر با آن موافق نیستید، لطفاً از سرویس‌ها استفاده نکنید.',
        ],
      },
      {
        heading: '۲. اطلاعاتی که جمع‌آوری می‌کنیم',
        paragraphs: [
          'اطلاعات حساب: نام، نشانی ایمیل، شماره تماس (در صورت ارائه) و مقدار هش‌شده رمز عبور برای ورود.',
          'اطلاعات محتوا: پیام‌ها، تیکت‌ها، فایل‌ها، مخاطبین و سایر محتوایی که شما یا کاربران شما در سرویس‌ها ثبت می‌کنید.',
          'اطلاعات استفاده: صفحات بازدیدشده، امکانات استفاده‌شده، موقعیت تقریبی بر اساس IP، نوع دستگاه، سیستم‌عامل، مرورگر و گزارش خطاها.',
          'اطلاعات تراکنش: طرح اشتراک، وضعیت صورتحساب و سوابق فاکتور. شماره کامل کارت بانکی هرگز نزد ما ذخیره نمی‌شود و توسط درگاه پرداخت مدیریت می‌شود.',
        ],
      },
      {
        heading: '۳. نحوه استفاده از اطلاعات',
        paragraphs: [
          'ایجاد و نگهداری حساب کاربری و احراز هویت شما.',
          'ارائه، اجرا، پشتیبانی، ایمن‌سازی و بهبود سرویس‌ها.',
          'اطلاع‌رسانی درباره به‌روزرسانی‌ها، هشدارهای امنیتی و درخواست‌های پشتیبانی.',
          'شناسایی، پیشگیری و بررسی تقلب، سوءاستفاده و نقض قوانین استفاده.',
          'رعایت الزامات قانونی.',
        ],
      },
      {
        heading: '۴. مبانی قانونی پردازش',
        paragraphs: [
          'در مواردی که قانون ایجاب کند، پردازش داده‌ها بر پایه اجرای قرارداد (ارائه سرویس درخواستی شما)، منافع مشروع (امنیت و بهبود محصول)، رضایت شما (ارتباطات اختیاری) و تکالیف قانونی انجام می‌شود.',
        ],
      },
      {
        heading: '۵. اشتراک‌گذاری و افشای اطلاعات',
        paragraphs: [
          'ما اطلاعات شخصی شما را نمی‌فروشیم و آن را برای تبلیغات شخص ثالث در اختیار دیگران قرار نمی‌دهیم.',
          'داده‌ها فقط با ارائه‌دهندگان خدماتی که از طرف ما کار می‌کنند (میزبانی، ذخیره‌سازی، ارسال ایمیل، آنالیز و پرداخت) و تحت تعهد محرمانگی، یا در صورت الزام قانونی، به اشتراک گذاشته می‌شود.',
        ],
      },
      {
        heading: '۶. حریم خصوصی کودکان',
        paragraphs: [
          'سرویس‌ها برای کودکان زیر ۱۳ سال طراحی نشده‌اند و ما آگاهانه اطلاعات آن‌ها را جمع‌آوری نمی‌کنیم. اگر فکر می‌کنید کودکی اطلاعاتی ارسال کرده است، با ما تماس بگیرید تا آن را حذف کنیم.',
        ],
      },
      {
        heading: '۷. امنیت داده‌ها',
        paragraphs: [
          'از رمزنگاری در انتقال (TLS)، هش کردن رمز عبور، کنترل دسترسی، ثبت رویدادها و پشتیبان‌گیری منظم استفاده می‌کنیم. هیچ روش انتقال یا ذخیره‌سازی کاملاً ایمن نیست، اما در صورت بروز رخنه، طبق قانون به شما اطلاع می‌دهیم.',
        ],
      },
      {
        heading: '۸. مدت نگهداری داده‌ها',
        paragraphs: [
          'اطلاعات شخصی تا زمانی که حساب شما فعال است و برای ارائه سرویس لازم باشد نگهداری می‌شود. پس از حذف حساب، داده‌های شخصی حداکثر ظرف ۳۰ روز حذف یا بی‌نام می‌شوند، مگر آنکه نگهداری طولانی‌تر از نظر قانونی، حسابداری یا امنیتی لازم باشد.',
        ],
      },
      {
        heading: '۹. حقوق شما و حذف حساب',
        paragraphs: [
          'شما می‌توانید هر زمان درخواست دسترسی، اصلاح، دریافت خروجی یا حذف اطلاعات شخصی خود را ثبت کنید و به پردازش‌های خاص اعتراض کرده یا رضایت خود را پس بگیرید.',
          'برای حذف حساب و تمام اطلاعات شخصی مرتبط، از همان ایمیل ثبت‌شده در حساب، پیامی با موضوع «درخواست حذف حساب» به {email} ارسال کنید. درخواست‌های تأییدشده ظرف ۳۰ روز انجام می‌شوند.',
        ],
      },
      {
        heading: '۱۰. کوکی‌ها و فناوری‌های مشابه',
        paragraphs: [
          'از کوکی‌های ضروری برای حفظ ورود شما و امنیت سرویس و از کوکی‌های اختیاری آنالیز برای درک نحوه استفاده بهره می‌گیریم. مدیریت کوکی‌ها از طریق تنظیمات مرورگر ممکن است؛ غیرفعال کردن کوکی‌های ضروری بخش‌هایی از سرویس را مختل می‌کند.',
        ],
      },
      {
        heading: '۱۱. انتقال بین‌المللی داده',
        paragraphs: [
          'ممکن است داده‌های شما روی سرورهایی خارج از کشور محل سکونت شما پردازش شود. در این موارد، تدابیر حفاظتی لازم مطابق قوانین حفاظت از داده اعمال می‌شود.',
        ],
      },
      {
        heading: '۱۲. تغییرات این سیاست',
        paragraphs: [
          'ممکن است این سیاست را به‌روزرسانی کنیم. تغییرات مهم با تاریخ اجرای جدید در همین صفحه و در صورت لزوم از طریق ایمیل یا اعلان درون‌برنامه‌ای اطلاع‌رسانی می‌شود.',
        ],
      },
      {
        heading: '۱۳. تماس با ما',
        paragraphs: [
          'پرسش‌ها، درخواست‌های حریم خصوصی یا شکایات: {email}',
          'به درخواست‌های حریم خصوصی حداکثر ظرف ۳۰ روز پاسخ می‌دهیم.',
        ],
      },
    ],
  },
  en: {
    pageTitle: 'Privacy Policy | Webyar',
    title: 'Privacy Policy',
    effective: 'Effective date: September 1, 2026 · Webyar',
    sections: [
      {
        heading: '1. Introduction',
        paragraphs: [
          'This Privacy Policy explains how Webyar collects, uses, discloses, stores and protects personal information when you use its website, applications and related services (the “Services”).',
          'By using the Services, you accept this policy. If you do not agree with it, please do not use the Services.',
        ],
      },
      {
        heading: '2. Information we collect',
        paragraphs: [
          'Account information: your name, email address, phone number (if provided) and a hashed value of your password for signing in.',
          'Content information: messages, tickets, files, contacts and other content that you or your users record in the Services.',
          'Usage information: pages visited, features used, approximate location based on IP address, device type, operating system, browser and error reports.',
          'Transaction information: subscription plan, billing status and invoice records. Full card numbers are never stored by us; they are handled by the payment gateway.',
        ],
      },
      {
        heading: '3. How we use information',
        paragraphs: [
          'To create and maintain your account and to authenticate you.',
          'To provide, operate, support, secure and improve the Services.',
          'To inform you about updates, security alerts and support requests.',
          'To detect, prevent and investigate fraud, abuse and violations of the terms of use.',
          'To comply with legal requirements.',
        ],
      },
      {
        heading: '4. Legal bases for processing',
        paragraphs: [
          'Where the law requires it, data is processed on the basis of performing a contract (providing the service you asked for), legitimate interests (security and product improvement), your consent (optional communications) and legal obligations.',
        ],
      },
      {
        heading: '5. Sharing and disclosure',
        paragraphs: [
          'We do not sell your personal information and do not make it available to others for third-party advertising.',
          'Data is shared only with service providers that work on our behalf (hosting, storage, email delivery, analytics and payments) under confidentiality obligations, or where the law requires it.',
        ],
      },
      {
        heading: '6. Children’s privacy',
        paragraphs: [
          'The Services are not designed for children under 13, and we do not knowingly collect their information. If you believe a child has submitted information, contact us so that we can delete it.',
        ],
      },
      {
        heading: '7. Data security',
        paragraphs: [
          'We use encryption in transit (TLS), password hashing, access control, event logging and regular backups. No method of transmission or storage is completely secure, but if a breach occurs we will notify you as the law requires.',
        ],
      },
      {
        heading: '8. Data retention',
        paragraphs: [
          'Personal information is kept for as long as your account is active and it is needed to provide the Services. After an account is deleted, its personal data is deleted or anonymized within 30 days at most, unless longer retention is needed for legal, accounting or security reasons.',
        ],
      },
      {
        heading: '9. Your rights and account deletion',
        paragraphs: [
          'You can at any time request access to, correction of, an export of or deletion of your personal information, object to particular processing, or withdraw your consent.',
          'To delete your account and all personal information associated with it, send a message with the subject “Account deletion request” to {email} from the email address registered on the account. Verified requests are completed within 30 days.',
        ],
      },
      {
        heading: '10. Cookies and similar technologies',
        paragraphs: [
          'We use essential cookies to keep you signed in and to secure the Services, and optional analytics cookies to understand how they are used. You can manage cookies in your browser’s settings; disabling essential cookies disrupts parts of the Services.',
        ],
      },
      {
        heading: '11. International data transfers',
        paragraphs: [
          'Your data may be processed on servers outside your country of residence. In those cases, the necessary safeguards are applied in accordance with data protection laws.',
        ],
      },
      {
        heading: '12. Changes to this policy',
        paragraphs: [
          'We may update this policy. Significant changes are announced on this page with a new effective date and, where necessary, by email or in-app notification.',
        ],
      },
      {
        heading: '13. Contact us',
        paragraphs: [
          'Questions, privacy requests or complaints: {email}',
          'We respond to privacy requests within 30 days at most.',
        ],
      },
    ],
  },
  tr: {
    pageTitle: 'Gizlilik Politikası | Webyar',
    title: 'Gizlilik Politikası',
    effective: 'Yürürlük tarihi: 1 Eylül 2026 · Webyar',
    sections: [
      {
        heading: '1. Giriş',
        paragraphs: [
          'Bu Gizlilik Politikası, Webyar’ın web sitesini, uygulamalarını ve ilgili hizmetlerini (“Hizmetler”) kullandığınızda kişisel bilgileri nasıl topladığını, kullandığını, açıkladığını, sakladığını ve koruduğunu açıklar.',
          'Hizmetleri kullanarak bu politikayı kabul etmiş olursunuz. Kabul etmiyorsanız lütfen Hizmetleri kullanmayın.',
        ],
      },
      {
        heading: '2. Topladığımız bilgiler',
        paragraphs: [
          'Hesap bilgileri: ad, e-posta adresi, telefon numarası (verilmişse) ve giriş için parolanızın karma (hash) değeri.',
          'İçerik bilgileri: sizin veya kullanıcılarınızın Hizmetler’e kaydettiği mesajlar, destek talepleri, dosyalar, kişiler ve diğer içerikler.',
          'Kullanım bilgileri: ziyaret edilen sayfalar, kullanılan özellikler, IP adresine dayalı yaklaşık konum, cihaz türü, işletim sistemi, tarayıcı ve hata raporları.',
          'İşlem bilgileri: abonelik planı, faturalandırma durumu ve fatura kayıtları. Tam kart numarası hiçbir zaman bizde saklanmaz; ödeme altyapısı tarafından işlenir.',
        ],
      },
      {
        heading: '3. Bilgileri nasıl kullanırız',
        paragraphs: [
          'Hesabınızı oluşturmak, sürdürmek ve kimliğinizi doğrulamak.',
          'Hizmetleri sunmak, işletmek, desteklemek, güvenli hale getirmek ve geliştirmek.',
          'Güncellemeler, güvenlik uyarıları ve destek talepleri hakkında sizi bilgilendirmek.',
          'Dolandırıcılığı, kötüye kullanımı ve kullanım koşullarının ihlalini tespit etmek, önlemek ve incelemek.',
          'Yasal yükümlülüklere uymak.',
        ],
      },
      {
        heading: '4. İşlemenin hukuki dayanakları',
        paragraphs: [
          'Yasanın gerektirdiği durumlarda veriler; sözleşmenin ifası (talep ettiğiniz hizmetin sunulması), meşru menfaatler (güvenlik ve ürün geliştirme), rızanız (isteğe bağlı iletişimler) ve yasal yükümlülükler temelinde işlenir.',
        ],
      },
      {
        heading: '5. Bilgilerin paylaşılması ve açıklanması',
        paragraphs: [
          'Kişisel bilgilerinizi satmayız ve üçüncü taraf reklamları için başkalarına sunmayız.',
          'Veriler yalnızca bizim adımıza çalışan ve gizlilik yükümlülüğü altındaki hizmet sağlayıcılarla (barındırma, depolama, e-posta gönderimi, analiz ve ödeme) ya da yasal zorunluluk halinde paylaşılır.',
        ],
      },
      {
        heading: '6. Çocukların gizliliği',
        paragraphs: [
          'Hizmetler 13 yaşın altındaki çocuklar için tasarlanmamıştır ve onların bilgilerini bilerek toplamayız. Bir çocuğun bilgi gönderdiğini düşünüyorsanız, silebilmemiz için bizimle iletişime geçin.',
        ],
      },
      {
        heading: '7. Veri güvenliği',
        paragraphs: [
          'Aktarım sırasında şifreleme (TLS), parola karma (hash) işlemi, erişim denetimi, olay kaydı ve düzenli yedekleme kullanırız. Hiçbir aktarım veya saklama yöntemi tamamen güvenli değildir; ancak bir ihlal olursa yasanın gerektirdiği şekilde sizi bilgilendiririz.',
        ],
      },
      {
        heading: '8. Veri saklama süresi',
        paragraphs: [
          'Kişisel bilgiler, hesabınız etkin olduğu ve Hizmetlerin sunulması için gerekli olduğu sürece saklanır. Hesap silindikten sonra kişisel veriler, yasal, muhasebesel veya güvenlik nedenleriyle daha uzun süre saklanması gerekmedikçe en geç 30 gün içinde silinir veya anonimleştirilir.',
        ],
      },
      {
        heading: '9. Haklarınız ve hesabın silinmesi',
        paragraphs: [
          'Kişisel bilgilerinize erişim, bunların düzeltilmesi, dışa aktarılması veya silinmesi için istediğiniz zaman talepte bulunabilir, belirli işlemelere itiraz edebilir ya da rızanızı geri çekebilirsiniz.',
          'Hesabınızı ve ilişkili tüm kişisel bilgileri silmek için, hesapta kayıtlı e-posta adresinizden {email} adresine “Hesap silme talebi” konulu bir mesaj gönderin. Doğrulanan talepler 30 gün içinde yerine getirilir.',
        ],
      },
      {
        heading: '10. Çerezler ve benzeri teknolojiler',
        paragraphs: [
          'Oturumunuzu açık tutmak ve hizmetin güvenliği için zorunlu çerezleri, kullanım şeklini anlamak için ise isteğe bağlı analiz çerezlerini kullanırız. Çerezleri tarayıcı ayarlarınızdan yönetebilirsiniz; zorunlu çerezleri devre dışı bırakmak Hizmetlerin bazı bölümlerini bozar.',
        ],
      },
      {
        heading: '11. Uluslararası veri aktarımı',
        paragraphs: [
          'Verileriniz, ikamet ettiğiniz ülkenin dışındaki sunucularda işlenebilir. Bu durumlarda veri koruma yasalarına uygun gerekli koruma önlemleri uygulanır.',
        ],
      },
      {
        heading: '12. Bu politikadaki değişiklikler',
        paragraphs: [
          'Bu politikayı güncelleyebiliriz. Önemli değişiklikler yeni yürürlük tarihiyle bu sayfada ve gerektiğinde e-posta veya uygulama içi bildirim yoluyla duyurulur.',
        ],
      },
      {
        heading: '13. Bize ulaşın',
        paragraphs: [
          'Sorular, gizlilik talepleri veya şikâyetler: {email}',
          'Gizlilik taleplerine en geç 30 gün içinde yanıt veririz.',
        ],
      },
    ],
  },
};

const TERMS: Record<Locale, LegalDocument> = {
  fa: {
    pageTitle: 'قوانین و شرایط استفاده | وب‌یار',
    title: 'قوانین و شرایط استفاده',
    effective: 'تاریخ اجرا: ۱۰ شهریور ۱۴۰۵ · وب‌یار',
    sections: [
      {
        heading: '۱. پذیرش قوانین',
        paragraphs: [
          'این قوانین استفاده، توافقی الزام‌آور میان شما و وب‌یار درباره استفاده از وب‌سایت، اپلیکیشن‌ها و سرویس‌های مرتبط («سرویس‌ها») است. با ساخت حساب یا استفاده از سرویس‌ها، این قوانین را می‌پذیرید.',
        ],
      },
      {
        heading: '۲. شرایط استفاده',
        paragraphs: [
          'برای استفاده از سرویس‌ها باید حداقل ۱۳ سال داشته باشید و اهلیت قانونی برای انعقاد قرارداد داشته باشید. اگر از طرف یک سازمان استفاده می‌کنید، تأیید می‌کنید که اختیار لازم را دارید.',
        ],
      },
      {
        heading: '۳. حساب کاربری و امنیت',
        paragraphs: [
          'مسئولیت صحت اطلاعات ثبت‌نام، حفظ محرمانگی اطلاعات ورود و تمام فعالیت‌های انجام‌شده با حساب شما بر عهده شماست. در صورت مشاهده دسترسی غیرمجاز، فوراً از طریق نشانی تماس زیر به ما اطلاع دهید.',
        ],
      },
      {
        heading: '۴. استفاده مجاز',
        paragraphs: [
          'شما می‌پذیرید که: قوانین را نقض نکنید؛ هرزنامه، بدافزار یا پیام انبوه ناخواسته ارسال نکنید؛ دیگران را آزار ندهید؛ محتوای غیرقانونی، ناقض حقوق، نفرت‌پراکن یا مستهجن بارگذاری نکنید؛ به داده سایر کاربران دسترسی نگیرید؛ سرویس را مهندسی معکوس، برداشت خودکار یا بیش از حد بارگذاری نکنید و بدون اجازه کتبی آن را بازفروش نکنید.',
          'حساب‌هایی که این بند را نقض کنند ممکن است تعلیق یا حذف شوند.',
        ],
      },
      {
        heading: '۵. محتوای کاربر',
        paragraphs: [
          'مالکیت محتوایی که ثبت می‌کنید نزد شما باقی می‌ماند. شما مجوزی محدود و غیرانحصاری به ما می‌دهید تا صرفاً برای اجرا و پشتیبانی سرویس‌ها، آن محتوا را میزبانی، پردازش، منتقل و نمایش دهیم.',
          'مسئولیت محتوا و داشتن حقوق لازم برای انتشار آن بر عهده شماست.',
        ],
      },
      {
        heading: '۶. اشتراک، صورتحساب و لغو',
        paragraphs: [
          'طرح‌های پولی به‌صورت دوره‌ای و پیش‌پرداخت صورتحساب می‌شوند و تا زمان لغو به‌طور خودکار تمدید می‌گردند. می‌توانید هر زمان از تنظیمات حساب یا با تماس با پشتیبانی لغو کنید؛ لغو در پایان دوره جاری اعمال می‌شود.',
          'خریدهای انجام‌شده از طریق اپ‌استور اپل یا گوگل‌پلی توسط همان فروشگاه صورتحساب می‌شوند و تابع قوانین تمدید و بازپرداخت آن فروشگاه هستند.',
        ],
      },
      {
        heading: '۷. سرویس‌های شخص ثالث',
        paragraphs: [
          'سرویس‌ها ممکن است با پلتفرم‌ها و افزونه‌های شخص ثالث یکپارچه شوند. آن سرویس‌ها تابع قوانین و سیاست حریم خصوصی خودشان هستند و ما مسئول در دسترس بودن یا عملکرد آن‌ها نیستیم.',
        ],
      },
      {
        heading: '۸. مالکیت فکری',
        paragraphs: [
          'تمام نرم‌افزار، طراحی، علائم تجاری و محتوای ارائه‌شده توسط وب‌یار متعلق به ما یا صاحبان مجوز ماست و تحت حمایت قوانین مالکیت فکری قرار دارد. جز آنچه صراحتاً در این قوانین آمده، حقی واگذار نمی‌شود.',
        ],
      },
      {
        heading: '۹. در دسترس بودن سرویس',
        paragraphs: [
          'تلاش می‌کنیم سرویس‌ها همواره در دسترس و پایدار باشند، اما آن‌ها «همان‌گونه که هست» ارائه می‌شوند و تا حدی که قانون اجازه می‌دهد، تضمینی همراه ندارند. نگهداری برنامه‌ریزی‌شده در صورت امکان از قبل اعلام می‌شود.',
        ],
      },
      {
        heading: '۱۰. محدودیت مسئولیت',
        paragraphs: [
          'تا بیشترین حد مجاز قانونی، وب‌یار مسئول خسارات غیرمستقیم، تبعی یا از دست رفتن سود و داده نیست. مجموع مسئولیت ما برای هر ادعا، محدود به مبلغی است که در دوازده ماه پیش از آن ادعا بابت سرویس پرداخت کرده‌اید.',
        ],
      },
      {
        heading: '۱۱. خاتمه',
        paragraphs: [
          'شما هر زمان می‌توانید استفاده را متوقف و حساب خود را حذف کنید. ما نیز می‌توانیم در صورت نقض این قوانین، الزام قانونی یا عدم فعالیت طولانی، دسترسی را تعلیق یا قطع کنیم و در حد امکان از پیش اطلاع می‌دهیم.',
        ],
      },
      {
        heading: '۱۲. تغییرات این قوانین',
        paragraphs: [
          'ممکن است این قوانین را به‌روزرسانی کنیم. تغییرات مهم با تاریخ اجرای جدید در همین صفحه و در صورت لزوم از طریق ایمیل یا اعلان درون‌برنامه‌ای اعلام می‌شود. ادامه استفاده به معنای پذیرش تغییرات است.',
        ],
      },
      {
        heading: '۱۳. قانون حاکم',
        paragraphs: [
          'این قوانین تابع مقررات محل اصلی فعالیت ما است. حمایت‌های الزامی مصرف‌کننده در کشور محل سکونت شما همچنان معتبر باقی می‌ماند.',
        ],
      },
      {
        heading: '۱۴. تماس',
        paragraphs: ['برای پرسش درباره این قوانین با {email} تماس بگیرید.'],
      },
    ],
  },
  en: {
    pageTitle: 'Terms of Use | Webyar',
    title: 'Terms of Use',
    effective: 'Effective date: September 1, 2026 · Webyar',
    sections: [
      {
        heading: '1. Acceptance of the terms',
        paragraphs: [
          'These Terms of Use are a binding agreement between you and Webyar about the use of its website, applications and related services (the “Services”). By creating an account or using the Services, you accept these terms.',
        ],
      },
      {
        heading: '2. Eligibility',
        paragraphs: [
          'To use the Services you must be at least 13 years old and legally able to enter into a contract. If you use them on behalf of an organization, you confirm that you have the authority to do so.',
        ],
      },
      {
        heading: '3. Account and security',
        paragraphs: [
          'You are responsible for the accuracy of your registration details, for keeping your sign-in details confidential and for all activity carried out with your account. If you notice unauthorized access, tell us immediately at the contact address below.',
        ],
      },
      {
        heading: '4. Acceptable use',
        paragraphs: [
          'You agree not to: break the law; send spam, malware or unsolicited bulk messages; harass others; upload illegal, infringing, hateful or obscene content; access other users’ data; reverse engineer, scrape or overload the Services; or resell them without written permission.',
          'Accounts that violate this section may be suspended or deleted.',
        ],
      },
      {
        heading: '5. User content',
        paragraphs: [
          'You keep ownership of the content you record. You grant us a limited, non-exclusive license to host, process, transmit and display that content solely to operate and support the Services.',
          'You are responsible for your content and for holding the rights needed to publish it.',
        ],
      },
      {
        heading: '6. Subscriptions, billing and cancellation',
        paragraphs: [
          'Paid plans are billed periodically in advance and renew automatically until cancelled. You can cancel at any time from your account settings or by contacting support; cancellation takes effect at the end of the current period.',
          'Purchases made through Apple’s App Store or Google Play are billed by that store and are subject to its renewal and refund rules.',
        ],
      },
      {
        heading: '7. Third-party services',
        paragraphs: [
          'The Services may integrate with third-party platforms and add-ons. Those services are subject to their own terms and privacy policies, and we are not responsible for their availability or performance.',
        ],
      },
      {
        heading: '8. Intellectual property',
        paragraphs: [
          'All software, designs, trademarks and content provided by Webyar belong to us or our licensors and are protected by intellectual property laws. Except as expressly stated in these terms, no rights are granted.',
        ],
      },
      {
        heading: '9. Service availability',
        paragraphs: [
          'We work to keep the Services available and stable at all times, but they are provided “as is” and, to the extent the law allows, without warranty. Planned maintenance is announced in advance where possible.',
        ],
      },
      {
        heading: '10. Limitation of liability',
        paragraphs: [
          'To the fullest extent permitted by law, Webyar is not liable for indirect or consequential damages or for lost profits or data. Our total liability for any claim is limited to the amount you paid for the Services in the twelve months before that claim.',
        ],
      },
      {
        heading: '11. Termination',
        paragraphs: [
          'You can stop using the Services and delete your account at any time. We may suspend or end access in case of a breach of these terms, a legal requirement or prolonged inactivity, and will give notice in advance where possible.',
        ],
      },
      {
        heading: '12. Changes to these terms',
        paragraphs: [
          'We may update these terms. Significant changes are announced on this page with a new effective date and, where necessary, by email or in-app notification. Continuing to use the Services means accepting the changes.',
        ],
      },
      {
        heading: '13. Governing law',
        paragraphs: [
          'These terms are governed by the laws of our principal place of business. Mandatory consumer protections in your country of residence continue to apply.',
        ],
      },
      {
        heading: '14. Contact',
        paragraphs: ['For questions about these terms, contact {email}.'],
      },
    ],
  },
  tr: {
    pageTitle: 'Kullanım Koşulları | Webyar',
    title: 'Kullanım Koşulları',
    effective: 'Yürürlük tarihi: 1 Eylül 2026 · Webyar',
    sections: [
      {
        heading: '1. Koşulların kabulü',
        paragraphs: [
          'Bu Kullanım Koşulları, Webyar’ın web sitesinin, uygulamalarının ve ilgili hizmetlerinin (“Hizmetler”) kullanımına ilişkin olarak sizinle Webyar arasında bağlayıcı bir sözleşmedir. Bir hesap oluşturarak veya Hizmetleri kullanarak bu koşulları kabul etmiş olursunuz.',
        ],
      },
      {
        heading: '2. Kullanım şartları',
        paragraphs: [
          'Hizmetleri kullanmak için en az 13 yaşında olmanız ve sözleşme yapma ehliyetine sahip olmanız gerekir. Bir kuruluş adına kullanıyorsanız, gerekli yetkiye sahip olduğunuzu onaylarsınız.',
        ],
      },
      {
        heading: '3. Hesap ve güvenlik',
        paragraphs: [
          'Kayıt bilgilerinizin doğruluğundan, giriş bilgilerinizin gizli tutulmasından ve hesabınızla yapılan tüm işlemlerden siz sorumlusunuz. Yetkisiz bir erişim fark ederseniz aşağıdaki iletişim adresinden derhal bize bildirin.',
        ],
      },
      {
        heading: '4. Kabul edilebilir kullanım',
        paragraphs: [
          'Şunları yapmamayı kabul edersiniz: yasaları ihlal etmek; istenmeyen e-posta, kötü amaçlı yazılım veya istenmeyen toplu mesaj göndermek; başkalarını taciz etmek; yasa dışı, hak ihlali içeren, nefret söylemi barındıran veya müstehcen içerik yüklemek; diğer kullanıcıların verilerine erişmek; Hizmetler’e tersine mühendislik uygulamak, otomatik veri kazımak veya aşırı yük bindirmek ya da yazılı izin olmadan yeniden satmak.',
          'Bu maddeyi ihlal eden hesaplar askıya alınabilir veya silinebilir.',
        ],
      },
      {
        heading: '5. Kullanıcı içeriği',
        paragraphs: [
          'Kaydettiğiniz içeriğin mülkiyeti sizde kalır. Bu içeriği yalnızca Hizmetleri işletmek ve desteklemek amacıyla barındırmamız, işlememiz, iletmemiz ve görüntülememiz için bize sınırlı ve münhasır olmayan bir lisans verirsiniz.',
          'İçeriğinizden ve onu yayımlamak için gerekli haklara sahip olmaktan siz sorumlusunuz.',
        ],
      },
      {
        heading: '6. Abonelik, faturalandırma ve iptal',
        paragraphs: [
          'Ücretli planlar dönemsel olarak peşin faturalandırılır ve iptal edilene kadar otomatik olarak yenilenir. İstediğiniz zaman hesap ayarlarınızdan veya destek ekibiyle iletişime geçerek iptal edebilirsiniz; iptal, mevcut dönemin sonunda geçerli olur.',
          'Apple App Store veya Google Play üzerinden yapılan satın almalar ilgili mağaza tarafından faturalandırılır ve o mağazanın yenileme ve iade kurallarına tabidir.',
        ],
      },
      {
        heading: '7. Üçüncü taraf hizmetleri',
        paragraphs: [
          'Hizmetler üçüncü taraf platformlar ve eklentilerle entegre olabilir. Bu hizmetler kendi koşullarına ve gizlilik politikalarına tabidir; bunların erişilebilirliğinden veya performansından sorumlu değiliz.',
        ],
      },
      {
        heading: '8. Fikri mülkiyet',
        paragraphs: [
          'Webyar tarafından sağlanan tüm yazılım, tasarım, ticari marka ve içerikler bize veya lisans verenlerimize aittir ve fikri mülkiyet yasalarıyla korunur. Bu koşullarda açıkça belirtilenler dışında hiçbir hak devredilmez.',
        ],
      },
      {
        heading: '9. Hizmetin erişilebilirliği',
        paragraphs: [
          'Hizmetlerin her zaman erişilebilir ve kararlı olması için çaba gösteririz; ancak Hizmetler “olduğu gibi” sunulur ve yasaların izin verdiği ölçüde herhangi bir garanti içermez. Planlı bakımlar mümkün olduğunda önceden duyurulur.',
        ],
      },
      {
        heading: '10. Sorumluluğun sınırlandırılması',
        paragraphs: [
          'Yasaların izin verdiği en geniş ölçüde Webyar; dolaylı veya sonuç olarak ortaya çıkan zararlardan ya da kâr veya veri kaybından sorumlu değildir. Herhangi bir talep için toplam sorumluluğumuz, o talepten önceki on iki ay içinde Hizmetler için ödediğiniz tutarla sınırlıdır.',
        ],
      },
      {
        heading: '11. Fesih',
        paragraphs: [
          'Hizmetleri kullanmayı istediğiniz zaman bırakabilir ve hesabınızı silebilirsiniz. Biz de bu koşulların ihlali, yasal bir zorunluluk veya uzun süreli hareketsizlik durumunda erişimi askıya alabilir veya sonlandırabiliriz ve mümkün olduğunca önceden bildiririz.',
        ],
      },
      {
        heading: '12. Bu koşullardaki değişiklikler',
        paragraphs: [
          'Bu koşulları güncelleyebiliriz. Önemli değişiklikler yeni yürürlük tarihiyle bu sayfada ve gerektiğinde e-posta veya uygulama içi bildirim yoluyla duyurulur. Kullanmaya devam etmeniz değişiklikleri kabul ettiğiniz anlamına gelir.',
        ],
      },
      {
        heading: '13. Uygulanacak hukuk',
        paragraphs: [
          'Bu koşullar, ana faaliyet yerimizin mevzuatına tabidir. İkamet ettiğiniz ülkedeki zorunlu tüketici korumaları geçerliliğini korur.',
        ],
      },
      {
        heading: '14. İletişim',
        paragraphs: ['Bu koşullarla ilgili sorularınız için {email} adresinden bize ulaşın.'],
      },
    ],
  },
};

export const LEGAL_DOCUMENTS: Record<LegalDocumentId, Record<Locale, LegalDocument>> = {
  privacy: PRIVACY,
  terms: TERMS,
};
