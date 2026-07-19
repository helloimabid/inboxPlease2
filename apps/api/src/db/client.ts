import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import type { Bindings } from '../env';
import * as schema from './schema';

export type Database = DrizzleD1Database<typeof schema>;

export function createDatabase(binding: Bindings['DB']): Database {
  return drizzle(binding, { schema });
}

