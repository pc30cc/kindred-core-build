import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { loadFontsForLocale } from "./lib/fonts";
import { getStoredLocale, loadLocaleMessages } from "./i18n";

// Set dir/lang immediately to prevent layout flash
const storedLocale = getStoredLocale();
loadFontsForLocale(storedLocale);
document.documentElement.lang = storedLocale;
document.documentElement.dir = ['fa', 'ar'].includes(storedLocale) ? 'rtl' : 'ltr';

async function bootstrap() {
  const initialTranslations = await loadLocaleMessages(storedLocale);

  createRoot(document.getElementById("root")!).render(
    <App initialLocale={storedLocale} initialTranslations={initialTranslations} />
  );
}

void bootstrap();
