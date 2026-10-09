using System.Collections.Generic;

namespace Webyar.Setup
{
    // The RESPOK build's words (-p:Brand=Respok): every line of Strings.cs that names the
    // product, in RESPOK's name. Lines that do not name it are shared.
    public sealed partial class Strings
    {
#if BRAND_RESPOK
        private static readonly Dictionary<string, string> BrandFa = new Dictionary<string, string>
        {
            ["appName"] = "RESPOK",
            ["welcomeTitle"] = "RESPOK را نصب کنید",
            ["updateTitle"] = "به‌روزرسانی RESPOK",
            ["welcomeBody"] = "چند ثانیه بیشتر طول نمی‌کشد و اجازه‌ی مدیر لازم ندارد. RESPOK برای شما نصب می‌شود، در منوی استارت می‌آید، خودش را درجا به‌روز می‌کند و از تنظیمات ویندوز قابل حذف است.",
            ["updateBody"] = "RESPOK روی این کامپیوتر نصب است. با ادامه، آخرین نسخه جایگزین می‌شود و تنظیمات و پیام‌هایتان دست نمی‌خورد.",
            ["optDesktopHint"] = "RESPOK را از روی دسکتاپ باز کنید",
            ["optLaunch"] = "باز کردن RESPOK بعد از نصب",
            ["installingTitle"] = "در حال نصب RESPOK…",
            ["doneTitle"] = "RESPOK آماده است",
            ["doneBody"] = "نصب با موفقیت انجام شد. RESPOK را از منوی استارت یا دسکتاپ هم می‌توانید باز کنید.",
            ["open"] = "باز کردن RESPOK",
            ["closingApp"] = "RESPOK در حال اجراست؛ برای نصب بسته می‌شود.",
            ["maintainTitle"] = "RESPOK نصب است",
            ["uninstallTitle"] = "حذف RESPOK",
            ["uninstallBody"] = "RESPOK، میانبرها و ورودی آن در تنظیمات ویندوز از این کامپیوتر حذف می‌شوند.",
            ["uninstallingTitle"] = "در حال حذف RESPOK…",
            ["uninstalledTitle"] = "RESPOK حذف شد",
            ["uninstalledBody"] = "RESPOK از این کامپیوتر حذف شد. هر وقت خواستید، می‌توانید دوباره نصبش کنید.",
            ["footer"] = "respok.app",
        };

        private static readonly Dictionary<string, string> BrandEn = new Dictionary<string, string>
        {
            ["appName"] = "RESPOK",
            ["welcomeTitle"] = "Install RESPOK",
            ["updateTitle"] = "Update RESPOK",
            ["welcomeBody"] = "It only takes a few seconds and needs no administrator rights. RESPOK installs for you, appears in the Start menu, updates itself in place and can be removed from Windows Settings.",
            ["updateBody"] = "RESPOK is already on this PC. Continue to replace it with the latest version; your settings and messages stay as they are.",
            ["optDesktopHint"] = "Open RESPOK from your desktop",
            ["optLaunch"] = "Open RESPOK when done",
            ["installingTitle"] = "Installing RESPOK…",
            ["doneTitle"] = "RESPOK is ready",
            ["doneBody"] = "Installation finished. You can also open RESPOK from the Start menu or your desktop.",
            ["open"] = "Open RESPOK",
            ["closingApp"] = "RESPOK is running; it will close to install.",
            ["maintainTitle"] = "RESPOK is installed",
            ["uninstallTitle"] = "Uninstall RESPOK",
            ["uninstallBody"] = "RESPOK, its shortcuts and its entry in Windows Settings will be removed from this PC.",
            ["uninstallingTitle"] = "Uninstalling RESPOK…",
            ["uninstalledTitle"] = "RESPOK was removed",
            ["uninstalledBody"] = "RESPOK has been removed from this PC. You can install it again at any time.",
            ["footer"] = "respok.app",
        };

        private static readonly Dictionary<string, string> BrandTr = new Dictionary<string, string>
        {
            ["appName"] = "RESPOK",
            ["welcomeTitle"] = "RESPOK'u yükleyin",
            ["updateTitle"] = "RESPOK'u güncelleyin",
            ["welcomeBody"] = "Yalnızca birkaç saniye sürer ve yönetici izni gerektirmez. RESPOK sizin için yüklenir, Başlat menüsünde görünür, kendini yerinde günceller ve Windows Ayarlar'dan kaldırılabilir.",
            ["updateBody"] = "RESPOK bu bilgisayarda zaten yüklü. Devam ederek en son sürüme geçin; ayarlarınız ve mesajlarınız korunur.",
            ["optDesktopHint"] = "RESPOK'u masaüstünden açın",
            ["optLaunch"] = "Bitince RESPOK'u aç",
            ["installingTitle"] = "RESPOK yükleniyor…",
            ["doneTitle"] = "RESPOK hazır",
            ["doneBody"] = "Yükleme tamamlandı. RESPOK'u Başlat menüsünden veya masaüstünden de açabilirsiniz.",
            ["open"] = "RESPOK'u aç",
            ["closingApp"] = "RESPOK çalışıyor; yükleme için kapatılacak.",
            ["maintainTitle"] = "RESPOK yüklü",
            ["uninstallTitle"] = "RESPOK'u kaldır",
            ["uninstallBody"] = "RESPOK, kısayolları ve Windows Ayarlar'daki kaydı bu bilgisayardan kaldırılacak.",
            ["uninstallingTitle"] = "RESPOK kaldırılıyor…",
            ["uninstalledTitle"] = "RESPOK kaldırıldı",
            ["uninstalledBody"] = "RESPOK bu bilgisayardan kaldırıldı. İstediğiniz zaman yeniden yükleyebilirsiniz.",
            ["footer"] = "respok.app",
        };

        private static Dictionary<string, string> Branded(Dictionary<string, string> map, Dictionary<string, string> brand)
        {
            var merged = new Dictionary<string, string>(map);
            foreach (var pair in brand) merged[pair.Key] = pair.Value;
            return merged;
        }
#else
        private static Dictionary<string, string> Branded(Dictionary<string, string> map, Dictionary<string, string> brand) => map;

        private static readonly Dictionary<string, string> BrandFa = null, BrandEn = null, BrandTr = null;
#endif
    }
}
