package com.webyar.operator.i18n

/**
 * The Visitors and Website analytics tabs' words — exactly the Mac and
 * Windows apps' own, generated from
 * `windows-native/src/Webyar.Core/Localization/strings.json` (the file the
 * desktop apps share), so the same screen reads the same on every device.
 *
 * A count goes in already formatted (`Format.number`): Kotlin's own
 * interpolation writes Latin digits into a Persian sentence.
 */
object StrInsights {
    fun visitorDevice(l: Language): String = when (l) {
        Language.EN -> "Device"
        Language.FA -> "دستگاه"
        Language.TR -> "Cihaz"
    }

    fun visitorLocation(l: Language): String = when (l) {
        Language.EN -> "Location"
        Language.FA -> "موقعیت"
        Language.TR -> "Konum"
    }

    fun visitorBrowser(l: Language): String = when (l) {
        Language.EN -> "Browser"
        Language.FA -> "مرورگر"
        Language.TR -> "Tarayıcı"
    }

    fun visitorAnonymous(l: Language, code: String): String = when (l) {
        Language.EN -> "Visitor · ${code}"
        Language.FA -> "بازدیدکننده · ${code}"
        Language.TR -> "Ziyaretçi · ${code}"
    }

    fun visitorAnonymousFromCity(l: Language, city: String, code: String): String = when (l) {
        Language.EN -> "Visitor from ${city} · ${code}"
        Language.FA -> "بازدیدکننده از ${city} · ${code}"
        Language.TR -> "${city} ziyaretçi · ${code}"
    }

    fun visitorAnonymousFromRegion(l: Language, region: String, code: String): String = when (l) {
        Language.EN -> "Visitor from ${region} · ${code}"
        Language.FA -> "بازدیدکننده از استان ${region} · ${code}"
        Language.TR -> "${region} ziyaretçi · ${code}"
    }

    fun navVisitors(l: Language): String = when (l) {
        Language.EN -> "Online Visitors"
        Language.FA -> "بازدیدکنندگان آنلاین"
        Language.TR -> "Çevrimiçi Ziyaretçiler"
    }

    fun visitorsSubtitle(l: Language): String = when (l) {
        Language.EN -> "Real-time visitor intelligence"
        Language.FA -> "هوش لحظه‌ای بازدیدکنندگان"
        Language.TR -> "Gerçek zamanlı ziyaretçi zekâsı"
    }

    fun visitorsSearch(l: Language): String = when (l) {
        Language.EN -> "Search by page, country, browser…"
        Language.FA -> "جستجو بر اساس صفحه، کشور، مرورگر…"
        Language.TR -> "Sayfa, ülke, tarayıcı ile ara…"
    }

    fun visitorsStatOnline(l: Language): String = when (l) {
        Language.EN -> "Online"
        Language.FA -> "آنلاین"
        Language.TR -> "Çevrimiçi"
    }

    fun visitorsStatActive(l: Language): String = when (l) {
        Language.EN -> "Active now"
        Language.FA -> "فعال"
        Language.TR -> "Şu an aktif"
    }

    fun visitorsStatCountries(l: Language): String = when (l) {
        Language.EN -> "Countries"
        Language.FA -> "کشورها"
        Language.TR -> "Ülkeler"
    }

    fun visitorsStatPages(l: Language): String = when (l) {
        Language.EN -> "Pages"
        Language.FA -> "صفحات"
        Language.TR -> "Sayfalar"
    }

    fun visitorsIncludeOffline(l: Language): String = when (l) {
        Language.EN -> "Include offline"
        Language.FA -> "نمایش آفلاین‌ها"
        Language.TR -> "Çevrimdışıları göster"
    }

    fun visitorsRefresh(l: Language): String = when (l) {
        Language.EN -> "Refresh"
        Language.FA -> "بروزرسانی"
        Language.TR -> "Yenile"
    }

    fun visitorsErrorTitle(l: Language): String = when (l) {
        Language.EN -> "Could not load visitors"
        Language.FA -> "بارگذاری بازدیدکنندگان ناموفق بود"
        Language.TR -> "Ziyaretçiler yüklenemedi"
    }

    fun visitorsRetry(l: Language): String = when (l) {
        Language.EN -> "Retry"
        Language.FA -> "تلاش مجدد"
        Language.TR -> "Tekrar dene"
    }

    fun visitorsEmptyTitle(l: Language): String = when (l) {
        Language.EN -> "No visitors right now"
        Language.FA -> "بازدیدکننده‌ای حضور ندارد"
        Language.TR -> "Şu anda ziyaretçi yok"
    }

    fun visitorsEmptyBody(l: Language): String = when (l) {
        Language.EN -> "Live visitors browsing your site will appear here."
        Language.FA -> "بازدیدکنندگان زنده‌ی سایت شما اینجا نمایش داده می‌شوند."
        Language.TR -> "Sitenizdeki canlı ziyaretçiler burada görünecek."
    }

    fun visitorsNoResults(l: Language): String = when (l) {
        Language.EN -> "No visitors match your search"
        Language.FA -> "بازدیدکننده‌ای با این جستجو یافت نشد"
        Language.TR -> "Aramayla eşleşen ziyaretçi yok"
    }

    fun visitorsUnknownLocation(l: Language): String = when (l) {
        Language.EN -> "Unknown location"
        Language.FA -> "موقعیت نامشخص"
        Language.TR -> "Bilinmeyen konum"
    }

    fun visitorOnline(l: Language): String = when (l) {
        Language.EN -> "Online"
        Language.FA -> "آنلاین"
        Language.TR -> "Çevrimiçi"
    }

    fun visitorIdle(l: Language): String = when (l) {
        Language.EN -> "Idle"
        Language.FA -> "بیکار"
        Language.TR -> "Boşta"
    }

    fun visitorOffline(l: Language): String = when (l) {
        Language.EN -> "Offline"
        Language.FA -> "آفلاین"
        Language.TR -> "Çevrimdışı"
    }

    fun visitorsJustNow(l: Language): String = when (l) {
        Language.EN -> "just now"
        Language.FA -> "هم‌اکنون"
        Language.TR -> "şimdi"
    }

    fun visitorsMinutesAgo(l: Language, n: String): String = when (l) {
        Language.EN -> "${n}m ago"
        Language.FA -> "${n} دقیقه پیش"
        Language.TR -> "${n}dk önce"
    }

    fun visitorsHoursAgo(l: Language, n: String): String = when (l) {
        Language.EN -> "${n}h ago"
        Language.FA -> "${n} ساعت پیش"
        Language.TR -> "${n}sa önce"
    }

    fun visitorsFilterOnline(l: Language): String = when (l) {
        Language.EN -> "Online"
        Language.FA -> "آنلاین"
        Language.TR -> "Çevrimiçi"
    }

    fun visitorsFilterChat(l: Language): String = when (l) {
        Language.EN -> "Has conversation"
        Language.FA -> "دارای گفتگو"
        Language.TR -> "Sohbeti olan"
    }

    fun visitorsFilterCountry(l: Language): String = when (l) {
        Language.EN -> "Country"
        Language.FA -> "کشور"
        Language.TR -> "Ülke"
    }

    fun visitorsAllCountries(l: Language): String = when (l) {
        Language.EN -> "All countries"
        Language.FA -> "همه کشورها"
        Language.TR -> "Tüm ülkeler"
    }

    fun visitorsClearFilters(l: Language): String = when (l) {
        Language.EN -> "Clear filters"
        Language.FA -> "پاک کردن فیلترها"
        Language.TR -> "Filtreleri temizle"
    }

    fun visitorDetails(l: Language): String = when (l) {
        Language.EN -> "Visitor details"
        Language.FA -> "جزئیات بازدیدکننده"
        Language.TR -> "Ziyaretçi detayları"
    }

    fun visitorOpenChat(l: Language): String = when (l) {
        Language.EN -> "Open chat"
        Language.FA -> "باز کردن گفتگو"
        Language.TR -> "Sohbeti aç"
    }

    fun visitorStartChat(l: Language): String = when (l) {
        Language.EN -> "Start chat"
        Language.FA -> "شروع گفتگو"
        Language.TR -> "Sohbet başlat"
    }

    fun visitorCopySession(l: Language): String = when (l) {
        Language.EN -> "Copy session ID"
        Language.FA -> "کپی شناسه نشست"
        Language.TR -> "Oturum kimliğini kopyala"
    }

    fun visitorCopied(l: Language): String = when (l) {
        Language.EN -> "Copied to clipboard"
        Language.FA -> "در کلیپ‌بورد کپی شد"
        Language.TR -> "Panoya kopyalandı"
    }

    fun visitorCurrentPage(l: Language): String = when (l) {
        Language.EN -> "Current Page"
        Language.FA -> "صفحه فعلی"
        Language.TR -> "Mevcut Sayfa"
    }

    fun visitorReferrer(l: Language): String = when (l) {
        Language.EN -> "Referrer"
        Language.FA -> "ارجاع‌دهنده"
        Language.TR -> "Yönlendiren"
    }

    fun visitorLastActivity(l: Language): String = when (l) {
        Language.EN -> "Last activity"
        Language.FA -> "آخرین فعالیت"
        Language.TR -> "Son etkinlik"
    }

    fun visitorIp(l: Language): String = when (l) {
        Language.EN -> "IP address"
        Language.FA -> "آدرس IP"
        Language.TR -> "IP adresi"
    }

    fun visitorPageHistory(l: Language): String = when (l) {
        Language.EN -> "Page history"
        Language.FA -> "تاریخچه صفحات"
        Language.TR -> "Sayfa geçmişi"
    }

    fun visitorPageHistoryEmpty(l: Language): String = when (l) {
        Language.EN -> "No page history yet"
        Language.FA -> "هنوز تاریخچه‌ای ثبت نشده"
        Language.TR -> "Henüz sayfa geçmişi yok"
    }

    fun visitorEntryPoint(l: Language): String = when (l) {
        Language.EN -> "Entry point"
        Language.FA -> "نقطه ورود"
        Language.TR -> "Giriş noktası"
    }

    fun visitorCurrentlyOn(l: Language): String = when (l) {
        Language.EN -> "Currently on"
        Language.FA -> "هم‌اکنون در"
        Language.TR -> "Şu anda"
    }

    fun visitorCameFromDirect(l: Language): String = when (l) {
        Language.EN -> "Direct visit"
        Language.FA -> "ورود مستقیم"
        Language.TR -> "Doğrudan ziyaret"
    }

    fun visitorJourney(l: Language): String = when (l) {
        Language.EN -> "Journey"
        Language.FA -> "مسیر بازدید"
        Language.TR -> "Gezinti"
    }

    fun visitorsCount(l: Language, count: String): String = when (l) {
        Language.EN -> "${count} visitors"
        Language.FA -> "${count} بازدیدکننده"
        Language.TR -> "${count} ziyaretçi"
    }

    fun visitorsActiveSessions(l: Language): String = when (l) {
        Language.EN -> "Active sessions"
        Language.FA -> "نشست‌های فعال"
        Language.TR -> "Aktif oturumlar"
    }

    fun visitorsMapHint(l: Language): String = when (l) {
        Language.EN -> "Where your visitors are right now"
        Language.FA -> "بازدیدکنندگان شما همین حالا کجا هستند"
        Language.TR -> "Ziyaretçileriniz şu anda nerede"
    }

    fun visitorBrowserOs(l: Language): String = when (l) {
        Language.EN -> "Browser · OS"
        Language.FA -> "مرورگر · سیستم‌عامل"
        Language.TR -> "Tarayıcı · İşletim sistemi"
    }

    fun visitorDeviceLabel(l: Language): String = when (l) {
        Language.EN -> "Device"
        Language.FA -> "دستگاه"
        Language.TR -> "Cihaz"
    }

    fun visitorInChat(l: Language): String = when (l) {
        Language.EN -> "In chat"
        Language.FA -> "در گفتگو"
        Language.TR -> "Sohbette"
    }

    fun visitorCameFrom(l: Language, source: String): String = when (l) {
        Language.EN -> "Came from ${source}"
        Language.FA -> "از طریق ${source}"
        Language.TR -> "${source} üzerinden geldi"
    }

    fun visitorLandedAt(l: Language, time: String): String = when (l) {
        Language.EN -> "Landed ${time}"
        Language.FA -> "ورود ${time}"
        Language.TR -> "${time} geldi"
    }

    fun navAnalytics(l: Language): String = when (l) {
        Language.EN -> "Website analytics"
        Language.FA -> "تحلیل وب‌سایت"
        Language.TR -> "Web sitesi analitiği"
    }

    fun waSubtitle(l: Language): String = when (l) {
        Language.EN -> "Visits recorded by the chat widget on your site"
        Language.FA -> "بازدیدهایی که ویجت گفتگو در سایت شما ثبت می‌کند"
        Language.TR -> "Sohbet widget'ının sitenizde kaydettiği ziyaretler"
    }

    fun waLiveNow(l: Language, count: String): String = when (l) {
        Language.EN -> "${count} on the site now"
        Language.FA -> "${count} نفر هم‌اکنون در سایت"
        Language.TR -> "Şu an sitede ${count} kişi"
    }

    fun waRange7(l: Language): String = when (l) {
        Language.EN -> "7 days"
        Language.FA -> "۷ روز"
        Language.TR -> "7 gün"
    }

    fun waRange28(l: Language): String = when (l) {
        Language.EN -> "28 days"
        Language.FA -> "۲۸ روز"
        Language.TR -> "28 gün"
    }

    fun waRange90(l: Language): String = when (l) {
        Language.EN -> "90 days"
        Language.FA -> "۹۰ روز"
        Language.TR -> "90 gün"
    }

    fun waOverview(l: Language): String = when (l) {
        Language.EN -> "Overview"
        Language.FA -> "نمای کلی"
        Language.TR -> "Genel bakış"
    }

    fun waOverviewHint(l: Language): String = when (l) {
        Language.EN -> "Visitors, visits and time on site"
        Language.FA -> "بازدیدکننده‌ها، بازدیدها و زمان حضور"
        Language.TR -> "Ziyaretçiler, ziyaretler ve sitede geçen süre"
    }

    fun waSources(l: Language): String = when (l) {
        Language.EN -> "Traffic sources"
        Language.FA -> "منابع ترافیک"
        Language.TR -> "Trafik kaynakları"
    }

    fun waSourcesHint(l: Language): String = when (l) {
        Language.EN -> "Where your visitors come from"
        Language.FA -> "بازدیدکننده‌ها از کجا می‌آیند"
        Language.TR -> "Ziyaretçileriniz nereden geliyor"
    }

    fun waPages(l: Language): String = when (l) {
        Language.EN -> "Pages"
        Language.FA -> "صفحات"
        Language.TR -> "Sayfalar"
    }

    fun waPagesHint(l: Language): String = when (l) {
        Language.EN -> "Most viewed, entry and exit pages"
        Language.FA -> "پربازدیدترین، صفحات ورود و خروج"
        Language.TR -> "En çok görüntülenen, giriş ve çıkış sayfaları"
    }

    fun waGeography(l: Language): String = when (l) {
        Language.EN -> "Geography"
        Language.FA -> "جغرافیا"
        Language.TR -> "Coğrafya"
    }

    fun waGeographyHint(l: Language): String = when (l) {
        Language.EN -> "Countries, cities and languages"
        Language.FA -> "کشورها، شهرها و زبان‌ها"
        Language.TR -> "Ülkeler, şehirler ve diller"
    }

    fun waTechnology(l: Language): String = when (l) {
        Language.EN -> "Devices & browsers"
        Language.FA -> "دستگاه و مرورگر"
        Language.TR -> "Cihaz ve tarayıcı"
    }

    fun waTechnologyHint(l: Language): String = when (l) {
        Language.EN -> "Device, operating system and browser"
        Language.FA -> "نوع دستگاه، سیستم‌عامل و مرورگر"
        Language.TR -> "Cihaz, işletim sistemi ve tarayıcı"
    }

    fun waEvents(l: Language): String = when (l) {
        Language.EN -> "Events"
        Language.FA -> "رویدادها"
        Language.TR -> "Olaylar"
    }

    fun waEventsHint(l: Language): String = when (l) {
        Language.EN -> "Custom events from your site"
        Language.FA -> "رویدادهای سفارشی سایت شما"
        Language.TR -> "Sitenizden özel olaylar"
    }

    fun waVisitors(l: Language): String = when (l) {
        Language.EN -> "Visitors"
        Language.FA -> "بازدیدکننده"
        Language.TR -> "Ziyaretçi"
    }

    fun waSessions(l: Language): String = when (l) {
        Language.EN -> "Visits"
        Language.FA -> "بازدید"
        Language.TR -> "Ziyaret"
    }

    fun waPageviews(l: Language): String = when (l) {
        Language.EN -> "Page views"
        Language.FA -> "بازدید صفحه"
        Language.TR -> "Sayfa görüntüleme"
    }

    fun waPagesPerSession(l: Language): String = when (l) {
        Language.EN -> "Pages per visit"
        Language.FA -> "صفحه در هر بازدید"
        Language.TR -> "Ziyaret başına sayfa"
    }

    fun waBounceRate(l: Language): String = when (l) {
        Language.EN -> "Bounce rate"
        Language.FA -> "نرخ پرش"
        Language.TR -> "Hemen çıkma oranı"
    }

    fun waAvgDuration(l: Language): String = when (l) {
        Language.EN -> "Avg. time on site"
        Language.FA -> "میانگین زمان حضور"
        Language.TR -> "Ort. sitede kalma"
    }

    fun waTrend(l: Language): String = when (l) {
        Language.EN -> "Traffic over time"
        Language.FA -> "روند ترافیک"
        Language.TR -> "Zaman içinde trafik"
    }

    fun waTopChannels(l: Language): String = when (l) {
        Language.EN -> "Top channels"
        Language.FA -> "کانال‌های برتر"
        Language.TR -> "En iyi kanallar"
    }

    fun waTopPages(l: Language): String = when (l) {
        Language.EN -> "Top pages"
        Language.FA -> "صفحات برتر"
        Language.TR -> "En iyi sayfalar"
    }

    fun waChannel(l: Language): String = when (l) {
        Language.EN -> "Channel"
        Language.FA -> "کانال"
        Language.TR -> "Kanal"
    }

    fun waSource(l: Language): String = when (l) {
        Language.EN -> "Source"
        Language.FA -> "منبع"
        Language.TR -> "Kaynak"
    }

    fun waCampaign(l: Language): String = when (l) {
        Language.EN -> "Campaign"
        Language.FA -> "کمپین"
        Language.TR -> "Kampanya"
    }

    fun waPagesTop(l: Language): String = when (l) {
        Language.EN -> "Most viewed"
        Language.FA -> "پربازدیدترین"
        Language.TR -> "En çok görüntülenen"
    }

    fun waPagesEntry(l: Language): String = when (l) {
        Language.EN -> "Entry pages"
        Language.FA -> "صفحات ورود"
        Language.TR -> "Giriş sayfaları"
    }

    fun waPagesExit(l: Language): String = when (l) {
        Language.EN -> "Exit pages"
        Language.FA -> "صفحات خروج"
        Language.TR -> "Çıkış sayfaları"
    }

    fun waCountry(l: Language): String = when (l) {
        Language.EN -> "Country"
        Language.FA -> "کشور"
        Language.TR -> "Ülke"
    }

    fun waCity(l: Language): String = when (l) {
        Language.EN -> "City"
        Language.FA -> "شهر"
        Language.TR -> "Şehir"
    }

    fun waLanguage(l: Language): String = when (l) {
        Language.EN -> "Language"
        Language.FA -> "زبان"
        Language.TR -> "Dil"
    }

    fun waDevice(l: Language): String = when (l) {
        Language.EN -> "Device"
        Language.FA -> "دستگاه"
        Language.TR -> "Cihaz"
    }

    fun waOs(l: Language): String = when (l) {
        Language.EN -> "Operating system"
        Language.FA -> "سیستم‌عامل"
        Language.TR -> "İşletim sistemi"
    }

    fun waBrowser(l: Language): String = when (l) {
        Language.EN -> "Browser"
        Language.FA -> "مرورگر"
        Language.TR -> "Tarayıcı"
    }

    fun waUnknown(l: Language): String = when (l) {
        Language.EN -> "Unknown"
        Language.FA -> "نامشخص"
        Language.TR -> "Bilinmiyor"
    }

    fun waNoData(l: Language): String = when (l) {
        Language.EN -> "No visits in this range yet"
        Language.FA -> "در این بازه هنوز بازدیدی نیست"
        Language.TR -> "Bu aralıkta henüz ziyaret yok"
    }

    fun waNoDataHint(l: Language): String = when (l) {
        Language.EN -> "The chat widget's snippet records every page view on your site; they show up here."
        Language.FA -> "اسکریپت ویجت گفتگو هر بازدید صفحه در سایت شما را ثبت می‌کند و اینجا نمایش داده می‌شود."
        Language.TR -> "Sohbet widget'ının kodu sitenizdeki her sayfa görüntülemeyi kaydeder; burada görünür."
    }

    fun waNoEvents(l: Language): String = when (l) {
        Language.EN -> "No custom events yet"
        Language.FA -> "هنوز رویداد سفارشی‌ای نیست"
        Language.TR -> "Henüz özel olay yok"
    }

    fun waNoEventsHint(l: Language): String = when (l) {
        Language.EN -> "Send them from your site with window.gsAnalytics.track('name')."
        Language.FA -> "از سایت خود با window.gsAnalytics.track('name') رویداد بفرستید."
        Language.TR -> "Sitenizden window.gsAnalytics.track('ad') ile gönderin."
    }

    fun waEventCount(l: Language): String = when (l) {
        Language.EN -> "Times"
        Language.FA -> "تعداد"
        Language.TR -> "Adet"
    }

    fun waEventSessions(l: Language): String = when (l) {
        Language.EN -> "Visits"
        Language.FA -> "بازدید"
        Language.TR -> "Ziyaret"
    }

    fun waConversion(l: Language): String = when (l) {
        Language.EN -> "Conversion"
        Language.FA -> "نرخ تبدیل"
        Language.TR -> "Dönüşüm"
    }

    fun waViews(l: Language): String = when (l) {
        Language.EN -> "views"
        Language.FA -> "بازدید"
        Language.TR -> "görüntüleme"
    }

    fun waVisitsUnit(l: Language): String = when (l) {
        Language.EN -> "visits"
        Language.FA -> "بازدید"
        Language.TR -> "ziyaret"
    }

    fun waShare(l: Language): String = when (l) {
        Language.EN -> "of visits"
        Language.FA -> "از بازدیدها"
        Language.TR -> "ziyaretlerin"
    }

    fun waTruncated(l: Language): String = when (l) {
        Language.EN -> "This range is very busy, so these numbers are from a sample of it."
        Language.FA -> "این بازه خیلی پرترافیک است؛ اعداد از نمونه‌ای از آن محاسبه شده‌اند."
        Language.TR -> "Bu aralık çok yoğun; rakamlar bir örneklemden hesaplandı."
    }

    fun waLocked(l: Language): String = when (l) {
        Language.EN -> "Website analytics is not in your plan"
        Language.FA -> "تحلیل وب‌سایت در پلن شما نیست"
        Language.TR -> "Web sitesi analitiği planınızda yok"
    }

    fun waLockedHint(l: Language): String = when (l) {
        Language.EN -> "The workspace owner can add it by upgrading the plan."
        Language.FA -> "مالک فضای کاری می‌تواند با ارتقای پلن آن را فعال کند."
        Language.TR -> "Çalışma alanı sahibi planı yükselterek ekleyebilir."
    }

    fun waMinutes(l: Language): String = when (l) {
        Language.EN -> "m"
        Language.FA -> "دقیقه"
        Language.TR -> "dk"
    }

    fun waSeconds(l: Language): String = when (l) {
        Language.EN -> "s"
        Language.FA -> "ثانیه"
        Language.TR -> "sn"
    }

    fun waVsPrevious(l: Language, count: String): String = when (l) {
        Language.EN -> "Compared with the ${count} days before"
        Language.FA -> "در مقایسه با ${count} روز قبل از آن"
        Language.TR -> "Önceki ${count} günle karşılaştırıldığında"
    }

    fun waTotal(l: Language): String = when (l) {
        Language.EN -> "Total"
        Language.FA -> "مجموع"
        Language.TR -> "Toplam"
    }

    fun waLeader(l: Language): String = when (l) {
        Language.EN -> "Top"
        Language.FA -> "در صدر"
        Language.TR -> "Zirvede"
    }

    fun waDistinct(l: Language): String = when (l) {
        Language.EN -> "Different items"
        Language.FA -> "تعداد موارد"
        Language.TR -> "Farklı öğe"
    }

    fun waBestEvent(l: Language): String = when (l) {
        Language.EN -> "Best converting"
        Language.FA -> "بیشترین نرخ تبدیل"
        Language.TR -> "En yüksek dönüşüm"
    }

    fun visitor(l: Language): String = when (l) {
        Language.EN -> "Visitor"
        Language.FA -> "بازدیدکننده"
        Language.TR -> "Ziyaretçi"
    }

    /** `waChannel_<key>`; null for a key there is no word for. */
    fun waChannelOf(key: String, l: Language): String? = when (key) {
        "direct" -> when (l) {
            Language.EN -> "Direct"
            Language.FA -> "مستقیم"
            Language.TR -> "Doğrudan"
        }
        "organic_search" -> when (l) {
            Language.EN -> "Organic search"
            Language.FA -> "جستجوی ارگانیک"
            Language.TR -> "Organik arama"
        }
        "paid_search" -> when (l) {
            Language.EN -> "Paid search"
            Language.FA -> "جستجوی پولی"
            Language.TR -> "Ücretli arama"
        }
        "organic_social" -> when (l) {
            Language.EN -> "Organic social"
            Language.FA -> "شبکه‌های اجتماعی"
            Language.TR -> "Organik sosyal"
        }
        "paid_social" -> when (l) {
            Language.EN -> "Paid social"
            Language.FA -> "تبلیغات شبکه‌های اجتماعی"
            Language.TR -> "Ücretli sosyal"
        }
        "email" -> when (l) {
            Language.EN -> "Email"
            Language.FA -> "ایمیل"
            Language.TR -> "E-posta"
        }
        "referral" -> when (l) {
            Language.EN -> "Referral"
            Language.FA -> "ارجاع از سایت‌ها"
            Language.TR -> "Yönlendirme"
        }
        "other" -> when (l) {
            Language.EN -> "Other"
            Language.FA -> "سایر"
            Language.TR -> "Diğer"
        }
        else -> null
    }

    /** `waDevice_<key>`; null for a key there is no word for. */
    fun waDeviceOf(key: String, l: Language): String? = when (key) {
        "desktop" -> when (l) {
            Language.EN -> "Desktop"
            Language.FA -> "دسکتاپ"
            Language.TR -> "Masaüstü"
        }
        "mobile" -> when (l) {
            Language.EN -> "Mobile"
            Language.FA -> "موبایل"
            Language.TR -> "Mobil"
        }
        "tablet" -> when (l) {
            Language.EN -> "Tablet"
            Language.FA -> "تبلت"
            Language.TR -> "Tablet"
        }
        else -> null
    }
}
