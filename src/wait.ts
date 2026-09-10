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
 * @throws EINTR when a signal arrives first
 */
export async function wait_event(queue: WaitQueue, condition: () => boolean, proc?: Process): Promise<void> {
	await wait_event_any([queue], condition, proc);
}

/**
 * Sleep until `condition` holds on any of several queues, i.e. what `do_poll` does.
 * @param timeout how long to wait in milliseconds, 0 to only look, or a negative number to wait forever
 * @returns whether the condition holds, i.e. false if the time ran out first
 * @throws EINTR when a signal arrives first
 */
export async function wait_event_any(queues: readonly WaitQueue[], condition: () => boolean, proc?: Process, timeout: number = -1): Promise<boolean> {
	const deadline = timeout < 0 ? Infinity : Date.now() + timeout;

	while (!condition()) {
		if (Date.now() >= deadline) return false;

		const interrupts = proc?.thread?.interrupts;
		const { promise, resolve } = Promise.withResolvers<void>();

		const remove = [...queues.map(queue => queue.wait_with(resolve)), proc?.sigwait.wait_with(resolve)];

		const timer = deadline == Infinity ? undefined : setTimeout(resolve, Math.max(0, deadline - Date.now()));

		try {
			await promise;
		} finally {
			for (const stop of remove) stop?.();
			clearTimeout(timer);
		}

		if (proc?.thread && proc.thread.interrupts !== interrupts) throw withErrno('EINTR');
	}

	return true;
}
