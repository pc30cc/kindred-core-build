/**
 * `lucide-react`, with its spinner icons swapped for the brand spinner.
 *
 * vite.config.ts aliases the bare `lucide-react` import here, so every
 * `<Loader2 className="h-4 w-4 animate-spin" />` in the app draws the launch
 * loader's two arcs without each call site changing. The real package is
 * reached through its file path, which the alias does not match.
 */
export * from 'lucide-react/dist/esm/lucide-react.js';
export {
  BrandSpinner as Loader2,
  BrandSpinner as Loader2Icon,
  BrandSpinner as LoaderCircle,
  BrandSpinner as LoaderCircleIcon,
  BrandSpinner as LucideLoader2,
  BrandSpinner as LucideLoaderCircle,
} from '@/components/brand/BrandSpinner';
