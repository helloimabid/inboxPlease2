import { z } from 'zod';

const email = z.string().trim().email().max(254);
const password = z.string().min(10).max(128);

export const signupSchema = z.object({
  name: z.string().trim().min(1).max(120),
  businessName: z.string().trim().min(1).max(160),
  email,
  password,
});

export const signinSchema = z.object({
  email,
  password,
});
