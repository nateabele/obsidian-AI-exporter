import { throttle, debounce } from '../../src/lib/throttle';

describe('throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('executes immediately on first call', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 1000);

    throttled();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('blocks subsequent calls within the limit period', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 1000);

    throttled();
    throttled();
    throttled();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('allows execution again after limit has elapsed', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 1000);

    throttled();
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1001);

    throttled();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('passes arguments to the throttled function', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 1000);

    throttled('arg1', 'arg2');

    expect(fn).toHaveBeenCalledWith('arg1', 'arg2');
  });

  it('ignores calls during throttle period then accepts next call', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 500);

    throttled(); // executes
    vi.advanceTimersByTime(200);
    throttled(); // ignored (within 500ms)
    vi.advanceTimersByTime(200);
    throttled(); // ignored (within 500ms)
    vi.advanceTimersByTime(200);

    // Now past 500ms total
    throttled(); // executes

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('handles zero limit', () => {
    const fn = vi.fn();
    const throttled = throttle(fn, 0);

    throttled();
    vi.advanceTimersByTime(1);
    throttled();

    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fire during a burst of rapid calls', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 1000);

    debounced();
    vi.advanceTimersByTime(400);
    debounced();
    vi.advanceTimersByTime(400);
    debounced();
    vi.advanceTimersByTime(400);

    expect(fn).not.toHaveBeenCalled();
  });

  it("fires exactly once after the quiet period, with the last call's arguments", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 1000);

    debounced('first');
    vi.advanceTimersByTime(400);
    debounced('second');
    vi.advanceTimersByTime(400);
    debounced('third');

    vi.advanceTimersByTime(999);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('third');
  });

  it('fires again for a later, separate burst', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 1000);

    debounced();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    debounced();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cancel() clears a pending timer so it never fires', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 1000);

    debounced();
    vi.advanceTimersByTime(500);
    debounced.cancel();
    vi.advanceTimersByTime(1000);

    expect(fn).not.toHaveBeenCalled();
  });

  it('cancel() is a no-op when nothing is pending', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 1000);

    expect(() => debounced.cancel()).not.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});
