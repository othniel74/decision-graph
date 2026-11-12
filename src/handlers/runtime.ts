import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/lifecycle';
import { SqlStore, runMigrations } from '../storage/sql';
import type { Deps } from '../services/context';

let cached: Deps | null = null;

const MISSING_TABLE = /doesn't exist|does not exist|no such table|Unknown table/i;

/**
 * The install event can arrive minutes after installation, so the first request may beat
 * the migrations. If a query fails on a missing table, run migrations once and retry.
 */
export function selfHealing<T extends object>(store: T, migrate: () => Promise<unknown>): T {
  let healed: Promise<unknown> | null = null;
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        try {
          return await value.apply(target, args);
        } catch (e) {
          if (!MISSING_TABLE.test((e as Error)?.message ?? '')) throw e;
          healed ??= migrate();
          await healed;
          return value.apply(target, args);
        }
      };
    },
  });
}

export function deps(): Deps {
  if (!cached) {
    cached = { store: selfHealing(new SqlStore(), runMigrations), now: () => new Date(), newId: () => randomUUID() };
  }
  return cached;
}

export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; error: string; code: string };

/** Convert thrown errors into a safe, user-readable result. Internal errors are logged, not leaked. */
export async function safely<T>(fn: () => Promise<T>): Promise<Ok<T> | Err> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof DomainError) return { ok: false, error: e.message, code: e.code };
    console.error('Unhandled error', e);
    return { ok: false, error: 'Something went wrong. Please try again.', code: 'INTERNAL' };
  }
}

/**
 * What to do when the decision check itself cannot run (e.g. storage unavailable).
 * Set with `forge variables set FAIL_MODE closed` to block instead of allowing.
 */
export function failClosed(): boolean {
  return (process.env.FAIL_MODE ?? 'open').toLowerCase() === 'closed';
}
