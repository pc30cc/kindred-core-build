import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://hmsfdmabjmtbshsqafqu.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhtc2ZkbWFiam10YnNoc3FhZnF1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTkyOTEsImV4cCI6MjA5MTY3NTI5MX0.gAyZiFmw_r5xJpHXIxu2ToCvtYgOsuYWzzmqmXaOy7I';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
