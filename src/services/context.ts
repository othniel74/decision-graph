import type { Store } from '../storage/store';

/** Everything services need from the outside world, injected so they stay testable. */
export interface Deps {
  store: Store;
  now: () => Date;
  newId: () => string;
}
