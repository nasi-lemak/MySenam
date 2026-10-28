import { AsyncLocalStorage } from "async_hooks";

/**
 * The member of staff a request acts for, while it is acting: so the
 * receipts and credit notes it writes, however deep in the code, keep who
 * took or gave back the money (migration 0234; lib/cash-up.ts), without every
 * function in between carrying it.
 *
 * A route sets it around the work it does for staff (`asStaff`); anything
 * written outside one (a customer's own payment, the scheduler) keeps nobody.
 */
export interface ActingStaff {
  id: number;
  name: string;
}

const store = new AsyncLocalStorage<ActingStaff>();

/** Run `work` as this member of staff. */
export function asStaff<T>(staff: ActingStaff, work: () => Promise<T>): Promise<T> {
  return store.run({ id: staff.id, name: staff.name }, work);
}

/** Who is acting now, or null outside a staff request. */
export function actingStaff(): ActingStaff | null {
  return store.getStore() ?? null;
}
