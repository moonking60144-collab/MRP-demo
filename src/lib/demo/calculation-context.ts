import { AsyncLocalStorage } from 'node:async_hooks';
import type { PrismaClient } from '@prisma/client';

const root = globalThis as typeof globalThis & { demoCalculationContext?: AsyncLocalStorage<PrismaClient> };
export const calculationContext = root.demoCalculationContext ??= new AsyncLocalStorage<PrismaClient>();
