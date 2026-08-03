import { useEffect } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowRight, Compass, Home, LifeBuoy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";

const NotFound = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { t, dir } = useTranslation();
  const isRtl = dir === "rtl";
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <main
      dir={dir}
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-16"
    >
      {/* ambient background */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute -top-32 start-1/4 h-96 w-96 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute -bottom-40 end-1/4 h-96 w-96 rounded-full bg-accent/30 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_35%,hsl(var(--background))_100%)]" />
      </div>

      <section className="relative z-10 w-full max-w-xl rounded-3xl border border-border/60 bg-card/70 p-8 text-center shadow-2xl backdrop-blur-xl sm:p-12">
        <span className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/60 px-3 py-1 text-xs font-medium text-muted-foreground">
          <Compass className="h-3.5 w-3.5 text-primary" />
          {t("notFound.badge")}
        </span>

        <h1 className="mt-6 bg-gradient-to-b from-foreground to-muted-foreground bg-clip-text text-7xl font-black leading-none tracking-tight text-transparent sm:text-8xl">
          {t("notFound.code")}
        </h1>

        <h2 className="mt-6 text-2xl font-semibold text-foreground sm:text-3xl">
          {t("notFound.title")}
        </h2>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
          {t("notFound.description")}
        </p>

        <div className="mt-6 rounded-xl border border-dashed border-border/70 bg-muted/40 px-4 py-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {t("notFound.pathLabel")}
          </p>
          <p dir="ltr" className="mt-1 truncate font-mono text-sm text-foreground">
            {location.pathname}
          </p>
        </div>

        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button asChild size="lg" className="w-full sm:w-auto">
            <Link to="/">
              <Home className="h-4 w-4" />
              {t("notFound.home")}
            </Link>
          </Button>
          <Button variant="outline" size="lg" className="w-full sm:w-auto" onClick={() => navigate(-1)}>
            <BackIcon className="h-4 w-4" />
            {t("notFound.back")}
          </Button>
          <Button asChild variant="ghost" size="lg" className="w-full sm:w-auto">
            <Link to="/contact">
              <LifeBuoy className="h-4 w-4" />
              {t("notFound.support")}
            </Link>
          </Button>
        </div>
      </section>
    </main>
  );
};

export default NotFound;
