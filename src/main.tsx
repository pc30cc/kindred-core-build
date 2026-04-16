import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { loadFontsForLocale } from "./lib/fonts";

// Set dir/lang immediately to prevent layout flash
const storedLocale = localStorage.getItem('app-locale') || 'en';
loadFontsForLocale(storedLocale);
document.documentElement.lang = storedLocale;
document.documentElement.dir = storedLocale === 'fa' ? 'rtl' : 'ltr';

createRoot(document.getElementById("root")!).render(<App />);
