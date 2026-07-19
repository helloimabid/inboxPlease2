import { defineConfig } from 'drizzle-kit';

const localDatabasePath = process.env.INBOXPLEASE_LOCAL_D1_PATH;

if (!localDatabasePath) {
  throw new Error(
    'Use `npm run db:studio`; the guarded launcher supplies the verified local D1 path.',
  );
}

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle-auth',
  dbCredentials: {
    url: localDatabasePath,
  },
  strict: true,
  verbose: true,
});
