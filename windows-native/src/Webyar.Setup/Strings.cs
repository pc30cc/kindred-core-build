using System.Collections.Generic;
using System.Text;

namespace Webyar.Setup
{
    /// <summary>The installer's words in the app's three languages; Persian first, as in the app.</summary>
    public sealed class Strings
    {
        public string Code { get; }
        public bool IsRightToLeft => Code == "fa";
        private readonly Dictionary<string, string> _map;

        private Strings(string code, Dictionary<string, string> map)
        {
            Code = code;
            _map = map;
        }

        public string this[string key] => _map.TryGetValue(key, out var v) ? v : key;

        /// <summary>Persian digits in Persian, so "۴۲٪" reads the way the app does.</summary>
        public string Digits(string text)
        {
            if (Code != "fa") return text;
            var b = new StringBuilder(text.Length);
            foreach (var ch in text) b.Append(ch >= '0' && ch <= '9' ? (char)('۰' + (ch - '0')) : ch);
            return b.ToString();
        }

        public static Strings For(string code)
        {
            switch (code)
            {
                case "en": return new Strings("en", En);
                case "tr": return new Strings("tr", Tr);
                default: return new Strings("fa", Fa);
            }
        }

        /// <summary>Persian, as the app itself starts; the picker in the corner switches.</summary>
        public static string SystemDefault() => "fa";

        private static readonly Dictionary<string, string> Fa = new Dictionary<string, string>
        {
            ["appName"] = "وب‌یار",
            ["tagline"] = "همه گفتگوها، تماس‌ها و هوش مصنوعی مشتریانتان در یک برنامه ویندوزی.",
            ["feature1"] = "صندوق گفتگوی زنده با همه کانال‌ها",
            ["feature2"] = "هوش مصنوعی که کنار شما پاسخ می‌دهد",
            ["feature3"] = "تماس صوتی و تصویری از داخل برنامه",
            ["version"] = "نسخه {0}",
            ["welcomeTitle"] = "وب‌یار را نصب کنید",
            ["updateTitle"] = "به‌روزرسانی وب‌یار",
            ["welcomeBody"] = "چند ثانیه بیشتر طول نمی‌کشد و اجازه‌ی مدیر لازم ندارد. وب‌یار برای شما نصب می‌شود، در منوی استارت می‌آید، خودش را درجا به‌روز می‌کند و از تنظیمات ویندوز قابل حذف است.",
            ["updateBody"] = "وب‌یار روی این کامپیوتر نصب است. با ادامه، آخرین نسخه جایگزین می‌شود و تنظیمات و پیام‌هایتان دست نمی‌خورد.",
            ["optDesktop"] = "میانبر روی دسکتاپ",
            ["optDesktopHint"] = "وب‌یار را از روی دسکتاپ باز کنید",
            ["optStartup"] = "اجرا همراه ویندوز",
            ["optStartupHint"] = "بی‌صدا در نوار وظیفه باز شود تا هیچ پیامی را از دست ندهید",
            ["optLaunch"] = "باز کردن وب‌یار بعد از نصب",
            ["optLaunchHint"] = "بلافاصله وارد حساب خود شوید",
            ["installTo"] = "محل نصب",
            ["install"] = "نصب",
            ["update"] = "به‌روزرسانی",
            ["cancel"] = "انصراف",
            ["installingTitle"] = "در حال نصب وب‌یار…",
            ["installingBody"] = "لطفاً این پنجره را نبندید.",
            ["stepPrepare"] = "آماده‌سازی",
            ["stepCopy"] = "کپی فایل‌های برنامه",
            ["stepShortcuts"] = "ساخت میانبرها",
            ["stepFinish"] = "پیکربندی نهایی",
            ["doneTitle"] = "وب‌یار آماده است",
            ["doneBody"] = "نصب با موفقیت انجام شد. وب‌یار را از منوی استارت یا دسکتاپ هم می‌توانید باز کنید.",
            ["open"] = "باز کردن وب‌یار",
            ["close"] = "بستن",
            ["errorTitle"] = "نصب کامل نشد",
            ["errorBody"] = "مشکلی پیش آمد. دوباره تلاش کنید؛ اگر تکرار شد، اینترنت و فضای خالی دیسک را بررسی کنید.",
            ["retry"] = "تلاش دوباره",
            ["noPayload"] = "این فایل نصب ناقص است. نسخه کامل را دوباره دانلود کنید.",
            ["closingApp"] = "وب‌یار در حال اجراست؛ برای نصب بسته می‌شود.",
            ["maintainTitle"] = "وب‌یار نصب است",
            ["maintainBody"] = "نسخه {0} روی این کامپیوتر نصب است. می‌توانید آن را به‌روزرسانی یا تعمیر کنید، یا به‌طور کامل حذفش کنید.",
            ["repair"] = "تعمیر",
            ["uninstall"] = "حذف برنامه",
            ["uninstallTitle"] = "حذف وب‌یار",
            ["uninstallBody"] = "وب‌یار، میانبرها و ورودی آن در تنظیمات ویندوز از این کامپیوتر حذف می‌شوند.",
            ["removeData"] = "حذف اطلاعات و تنظیمات من",
            ["removeDataHint"] = "ورود به حساب، تنظیمات و فایل‌های دانلودشده هم پاک شوند",
            ["uninstallingTitle"] = "در حال حذف وب‌یار…",
            ["stepRemove"] = "حذف فایل‌ها و میانبرها",
            ["uninstalledTitle"] = "وب‌یار حذف شد",
            ["uninstalledBody"] = "وب‌یار از این کامپیوتر حذف شد. هر وقت خواستید، می‌توانید دوباره نصبش کنید.",
            ["uninstallErrorTitle"] = "حذف کامل نشد",
            ["footer"] = "webyar.ai",
            ["minimize"] = "کوچک کردن",
        };

        private static readonly Dictionary<string, string> En = new Dictionary<string, string>
        {
            ["appName"] = "Webyar",
            ["tagline"] = "Every conversation, call and AI answer for your customers, in one Windows app.",
            ["feature1"] = "A live inbox for every channel",
            ["feature2"] = "AI that answers alongside you",
            ["feature3"] = "Voice and video calls built in",
            ["version"] = "Version {0}",
            ["welcomeTitle"] = "Install Webyar",
            ["updateTitle"] = "Update Webyar",
            ["welcomeBody"] = "It only takes a few seconds and needs no administrator rights. Webyar installs for you, appears in the Start menu, updates itself in place and can be removed from Windows Settings.",
            ["updateBody"] = "Webyar is already on this PC. Continue to replace it with the latest version; your settings and messages stay as they are.",
            ["optDesktop"] = "Desktop shortcut",
            ["optDesktopHint"] = "Open Webyar from your desktop",
            ["optStartup"] = "Start with Windows",
            ["optStartupHint"] = "Opens quietly in the tray so you never miss a message",
            ["optLaunch"] = "Open Webyar when done",
            ["optLaunchHint"] = "Sign in straight away",
            ["installTo"] = "Install location",
            ["install"] = "Install",
            ["update"] = "Update",
            ["cancel"] = "Cancel",
            ["installingTitle"] = "Installing Webyar…",
            ["installingBody"] = "Please keep this window open.",
            ["stepPrepare"] = "Getting ready",
            ["stepCopy"] = "Copying the app",
            ["stepShortcuts"] = "Creating shortcuts",
            ["stepFinish"] = "Finishing up",
            ["doneTitle"] = "Webyar is ready",
            ["doneBody"] = "Installation finished. You can also open Webyar from the Start menu or your desktop.",
            ["open"] = "Open Webyar",
            ["close"] = "Close",
            ["errorTitle"] = "Installation didn't finish",
            ["errorBody"] = "Something went wrong. Try again; if it keeps happening, check your internet connection and free disk space.",
            ["retry"] = "Try again",
            ["noPayload"] = "This installer is incomplete. Please download the full version again.",
            ["closingApp"] = "Webyar is running; it will close to install.",
            ["maintainTitle"] = "Webyar is installed",
            ["maintainBody"] = "Version {0} is installed on this PC. You can update or repair it, or remove it completely.",
            ["repair"] = "Repair",
            ["uninstall"] = "Uninstall",
            ["uninstallTitle"] = "Uninstall Webyar",
            ["uninstallBody"] = "Webyar, its shortcuts and its entry in Windows Settings will be removed from this PC.",
            ["removeData"] = "Remove my data and settings",
            ["removeDataHint"] = "Also delete your sign-in, settings and downloaded files",
            ["uninstallingTitle"] = "Uninstalling Webyar…",
            ["stepRemove"] = "Removing files and shortcuts",
            ["uninstalledTitle"] = "Webyar was removed",
            ["uninstalledBody"] = "Webyar has been removed from this PC. You can install it again at any time.",
            ["uninstallErrorTitle"] = "Uninstall didn't finish",
            ["footer"] = "webyar.ai",
            ["minimize"] = "Minimize",
        };

        private static readonly Dictionary<string, string> Tr = new Dictionary<string, string>
        {
            ["appName"] = "Webyar",
            ["tagline"] = "Müşterilerinizin tüm sohbetleri, aramaları ve yapay zekâ yanıtları tek bir Windows uygulamasında.",
            ["feature1"] = "Tüm kanallar için canlı gelen kutusu",
            ["feature2"] = "Sizinle birlikte yanıt veren yapay zekâ",
            ["feature3"] = "Uygulama içinden sesli ve görüntülü arama",
            ["version"] = "Sürüm {0}",
            ["welcomeTitle"] = "Webyar'ı yükleyin",
            ["updateTitle"] = "Webyar'ı güncelleyin",
            ["welcomeBody"] = "Yalnızca birkaç saniye sürer ve yönetici izni gerektirmez. Webyar sizin için yüklenir, Başlat menüsünde görünür, kendini yerinde günceller ve Windows Ayarlar'dan kaldırılabilir.",
            ["updateBody"] = "Webyar bu bilgisayarda zaten yüklü. Devam ederek en son sürüme geçin; ayarlarınız ve mesajlarınız korunur.",
            ["optDesktop"] = "Masaüstü kısayolu",
            ["optDesktopHint"] = "Webyar'ı masaüstünden açın",
            ["optStartup"] = "Windows ile başlat",
            ["optStartupHint"] = "Hiçbir mesajı kaçırmamak için tepside sessizce açılır",
            ["optLaunch"] = "Bitince Webyar'ı aç",
            ["optLaunchHint"] = "Hemen oturum açın",
            ["installTo"] = "Yükleme konumu",
            ["install"] = "Yükle",
            ["update"] = "Güncelle",
            ["cancel"] = "İptal",
            ["installingTitle"] = "Webyar yükleniyor…",
            ["installingBody"] = "Lütfen bu pencereyi kapatmayın.",
            ["stepPrepare"] = "Hazırlanıyor",
            ["stepCopy"] = "Uygulama kopyalanıyor",
            ["stepShortcuts"] = "Kısayollar oluşturuluyor",
            ["stepFinish"] = "Son ayarlar",
            ["doneTitle"] = "Webyar hazır",
            ["doneBody"] = "Yükleme tamamlandı. Webyar'ı Başlat menüsünden veya masaüstünden de açabilirsiniz.",
            ["open"] = "Webyar'ı aç",
            ["close"] = "Kapat",
            ["errorTitle"] = "Yükleme tamamlanamadı",
            ["errorBody"] = "Bir sorun oluştu. Yeniden deneyin; tekrar ederse internet bağlantınızı ve boş disk alanını kontrol edin.",
            ["retry"] = "Yeniden dene",
            ["noPayload"] = "Bu yükleyici eksik. Lütfen tam sürümü yeniden indirin.",
            ["closingApp"] = "Webyar çalışıyor; yükleme için kapatılacak.",
            ["maintainTitle"] = "Webyar yüklü",
            ["maintainBody"] = "Bu bilgisayarda {0} sürümü yüklü. Güncelleyebilir, onarabilir veya tamamen kaldırabilirsiniz.",
            ["repair"] = "Onar",
            ["uninstall"] = "Kaldır",
            ["uninstallTitle"] = "Webyar'ı kaldır",
            ["uninstallBody"] = "Webyar, kısayolları ve Windows Ayarlar'daki kaydı bu bilgisayardan kaldırılacak.",
            ["removeData"] = "Verilerimi ve ayarlarımı sil",
            ["removeDataHint"] = "Oturumunuz, ayarlarınız ve indirilen dosyalar da silinsin",
            ["uninstallingTitle"] = "Webyar kaldırılıyor…",
            ["stepRemove"] = "Dosyalar ve kısayollar kaldırılıyor",
            ["uninstalledTitle"] = "Webyar kaldırıldı",
            ["uninstalledBody"] = "Webyar bu bilgisayardan kaldırıldı. İstediğiniz zaman yeniden yükleyebilirsiniz.",
            ["uninstallErrorTitle"] = "Kaldırma tamamlanamadı",
            ["footer"] = "webyar.ai",
            ["minimize"] = "Simge durumuna küçült",
        };
    }
}
