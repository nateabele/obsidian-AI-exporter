/**
 * Leading-edge throttle and trailing-edge debounce utilities
 */

/**
 * Create a throttled version of a function.
 * The function executes on the leading edge (immediately on first call),
 * then ignores subsequent calls until `limit` ms have elapsed.
 *
 * @param fn - Function to throttle
 * @param limit - Minimum interval between executions (ms)
 */
export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false;
  return (...args: Parameters<T>) => {
    if (!inThrottle) {
      fn(...args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

/**
 * Create a debounced version of a function.
 * Each call resets a pending timer; `fn` only runs once `delay` ms have
 * elapsed with no further calls, and receives the arguments of the LAST
 * call in the burst (trailing edge, no leading call, no max wait).
 *
 * Use this — not `throttle` — for anything driven by a stream of DOM
 * mutations that settles (e.g. a streaming chat response): throttle's
 * leading-edge, no-trailing-call behavior would fire on the first partial
 * mutation and then never fire again for the rest of the burst.
 *
 * @param fn - Function to debounce
 * @param delay - Quiet period required before `fn` runs (ms)
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  delay: number
): ((...args: Parameters<T>) => void) & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: Parameters<T>) => {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  };
  debounced.cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return debounced;
}
