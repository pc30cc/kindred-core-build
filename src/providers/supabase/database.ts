import { supabase } from '@/lib/supabase';
import type { DatabaseProvider, QueryOptions, MutationResult } from '@/types/providers';

export const supabaseDatabaseProvider: DatabaseProvider = {
  async query<T = unknown>(options: QueryOptions): Promise<MutationResult<T[]>> {
    let q = supabase.from(options.table).select(options.select ?? '*');

    if (options.filters) {
      Object.entries(options.filters).forEach(([key, value]) => {
        q = q.eq(key, value);
      });
    }
    if (options.order) {
      q = q.order(options.order.column, { ascending: options.order.ascending ?? true });
    }
    if (options.limit) q = q.limit(options.limit);
    if (options.offset) q = q.range(options.offset, options.offset + (options.limit ?? 10) - 1);

    const { data, error } = await q;
    return { data: (data as T[]) ?? null, error: error ? new Error(error.message) : null };
  },

  async getById<T = unknown>(table: string, id: string, select?: string): Promise<MutationResult<T>> {
    const { data, error } = await supabase.from(table).select(select ?? '*').eq('id', id).single();
    return { data: (data as T) ?? null, error: error ? new Error(error.message) : null };
  },

  async insert<T = unknown>(table: string, data: Partial<T>): Promise<MutationResult<T>> {
    const { data: result, error } = await supabase.from(table).insert(data as any).select().single();
    return { data: (result as T) ?? null, error: error ? new Error(error.message) : null };
  },

  async update<T = unknown>(table: string, id: string, data: Partial<T>): Promise<MutationResult<T>> {
    const { data: result, error } = await supabase.from(table).update(data as any).eq('id', id).select().single();
    return { data: (result as T) ?? null, error: error ? new Error(error.message) : null };
  },

  async delete(table: string, id: string): Promise<MutationResult<null>> {
    const { error } = await supabase.from(table).delete().eq('id', id);
    return { data: null, error: error ? new Error(error.message) : null };
  },

  async rpc<T = unknown>(fn: string, params?: Record<string, unknown>): Promise<MutationResult<T>> {
    const { data, error } = await supabase.rpc(fn, params);
    return { data: (data as T) ?? null, error: error ? new Error(error.message) : null };
  },
};
