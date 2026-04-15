import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { loadFontsForLocale } from "./lib/fonts";

// Load fonts immediately based on stored locale
const storedLocale = localStorage.getItem('app-locale') || 'en';
loadFontsForLocale(storedLocale);

createRoot(document.getElementById("root")!).render(<App />);
