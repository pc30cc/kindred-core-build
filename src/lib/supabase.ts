import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://bdycuenbjztkgnaqonfm.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkeWN1ZW5ianp0a2duYXFvbmZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYwOTczODksImV4cCI6MjA5MTY3MzM4OX0.YDa2Gt-ZjADDmN5jpJZGaUiEsB152x4IsQG7yE0qiEk';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
