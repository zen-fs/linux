// SPDX-License-Identifier: LGPL-3.0-or-later
/** How a thread talks to the kernel. Web workers keep this on the global; Node's do not. */
import type { FromThread, ToThread } from './abi.js';

/** Kept out of the import so it stays opaque to bundlers */
const node_worker_threads = 'node:' + 'worker_threads';

const handlers = new Set<(message: ToThread) => void>();

function dispatch(message: ToThread): void {
	for (const handler of handlers) handler(message);
}

/** Hand a message to the kernel */
export let send: (message: FromThread) => void;

if (typeof postMessage == 'function') {
	send = message => postMessage(message);
	addEventListener('message', event => dispatch((event as MessageEvent<ToThread>).data));
} else {
	// Built so a bundler can't resolve it: a browser build never runs this, and would fail on it
	const { parentPort } = (await import(/* @vite-ignore */ node_worker_threads)) as typeof import('node:worker_threads');
	if (!parentPort) throw new Error('uapi was loaded outside of a thread');
	send = message => parentPort.postMessage(message);
	parentPort.on('message', dispatch);
}

/** Be told about every message the kernel sends */
export function receive(handler: (message: ToThread) => void): void {
	handlers.add(handler);
}
