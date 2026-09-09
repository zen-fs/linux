// SPDX-License-Identifier: LGPL-3.0-or-later
import { withErrno } from 'kerium';
import type { Process } from './process.js';

/**
 * Somewhere for tasks to sleep until something happens, i.e. `wait_queue_head_t`.
 *
 * Nothing here actually sleeps a thread: the process is already blocked on the shared page while the
 * kernel works, so a waiter is just a promise the kernel holds until whatever it is waiting on wakes it.
 */
export class WaitQueue {
	protected readonly waiters = new Set<() => void>();

	public get waiting(): number {
		return this.waiters.size;
	}

	/** Sleep until something wakes the queue, i.e. `add_wait_queue` and then `schedule` */
	public wait(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();

		const waiter = () => {
			this.waiters.delete(waiter);
			resolve();
		};

		this.waiters.add(waiter);
		return promise;
	}

	/**
	 * Wake up a waiter, i.e. `add_wait_queue` and `remove_wait_queue` around one sleep.
	 * @returns a function that stops waiting without the queue having been woken
	 */
	public wait_with(waiter: () => void): () => void {
		this.waiters.add(waiter);
		return () => this.waiters.delete(waiter);
	}

	/** Wake everything on the queue, i.e. `wake_up` */
	public wake_up(): void {
		for (const waiter of [...this.waiters]) waiter();
	}
}

/**
 * Sleep until `condition` holds, i.e. `wait_event_interruptible`.
 *
 * A signal ends the wait with `EINTR`. Linux would return `-ERESTARTSYS` and restart the call once
 * the handler is done; here the handler runs in userspace when the syscall comes back, so what it
 * sees is the `EINTR` a syscall with `SA_RESTART` off would give.
 *
 * @throws EINTR when a signal arrives first
 */
export async function wait_event(queue: WaitQueue, condition: () => boolean, proc?: Process): Promise<void> {
	while (!condition()) {
		const interrupts = proc?.thread?.interrupts;
		const { promise, resolve } = Promise.withResolvers<void>();

		// `add_wait_queue` and `remove_wait_queue` around one sleep, so nothing is left on a queue
		const remove = [queue.wait_with(resolve), proc?.sigwait.wait_with(resolve)];

		try {
			await promise;
		} finally {
			for (const stop of remove) stop?.();
		}

		if (proc?.thread && proc.thread.interrupts !== interrupts) throw withErrno('EINTR');
	}
}
