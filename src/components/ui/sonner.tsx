import { useTheme } from "next-themes";
import { Toaster as Sonner, toast } from "sonner";
import { useI18n } from "@/i18n";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();
  const { dir } = useI18n();
  const isRtl = dir === "rtl";

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      dir={dir}
      position={isRtl ? "bottom-left" : "bottom-right"}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg rtl:text-right rtl:flex-row-reverse",
          title: "rtl:text-right",
          description: "group-[.toast]:text-muted-foreground rtl:text-right",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster, toast };
