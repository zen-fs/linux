// SPDX-License-Identifier: LGPL-3.0-or-later
import type { FSContext } from '@zenfs/core';
import { bindContext, boundContexts, defaultContext, fs } from '@zenfs/core';
import { O_RDWR } from '@zenfs/core/constants';
import { dupFD } from '@zenfs/core/vfs/file.js';
import { UV } from 'kerium';
import { console_tty } from './drivers/tty/console.js';
import type { TTY } from './drivers/tty/tty.js';

export interface ProcessInit {
	argv?: string[];
	env?: Record<string, string>;
	cwd?: string;
	parent?: Process;
	tty?: TTY | null;
	context?: FSContext;
	/**
	 * What to open the standard descriptors on when there is no parent to inherit them from.
	 * @default '/dev/console'
	 */
	console?: string;
}

export const processes = new Map<number, Process>();

/** A process, basically the same as `struct task_struct` */
export class Process {
	/** The context this process runs in. Its id is the pid. */
	public readonly context: FSContext;

	/** Whatever forked this process, or whatever adopted it once that exited. */
	public parent?: Process;

	public readonly children = new Set<Process>();

	public argv: string[];
	public env: Record<string, string> = {};

	/** The controlling terminal */
	public readonly tty: TTY | null;

	/** The path of the program currently loaded */
	public exe?: string;

	/** What the process stopped with, once it has. */
	public code?: number;

	/** A pid is the id of the process' context. */
	public get pid(): number {
		return this.context.id;
	}

	public get ppid(): number {
		return this.parent?.pid ?? 0;
	}

	/** The name of the program without its path. */
	public get comm(): string {
		return (this.exe ?? this.argv[0] ?? '').split('/').pop() ?? '';
	}

	public constructor(init: ProcessInit = {}) {
		this.parent = init.parent;

		const parent = init.parent?.context ?? defaultContext;
		this.context = init.context ?? bindContext.call(parent, { pwd: init.cwd ?? parent.pwd });

		this.argv = init.argv ?? [];
		this.env = init.env ?? {};

		this.tty = init.tty !== undefined ? init.tty : (init.parent?.tty ?? console_tty);

		if (init.parent)
			for (const [fd, handle] of init.parent.context.descriptors) {
				this.context.descriptors.set(fd, handle.ref());
			}
		else {
			const fd = fs.openSync.call(this.context, init.console ?? '/dev/console', O_RDWR);
			dupFD(this.context, fd);
			dupFD(this.context, fd);
		}

		this.parent?.children.add(this);
		processes.set(this.pid, this);
	}

	public get cwd(): string {
		return this.context.pwd;
	}

	public chdir(directory: string): void {
		const target = fs.realpathSync.call(this.context, directory);
		if (!fs.statSync.call(this.context, target)!.isDirectory()) throw UV('ENOTDIR', { syscall: 'chdir', path: target });
		this.context.pwd = target;
		this.env.PWD = target;
	}

	/** Release everything the process was holding and drop it from the table */
	public dispose(): void {
		const init = processes.get(1);

		for (const child of this.children) {
			if (!init || init === this) child.dispose();
			else {
				this.children.delete(child);
				child.parent = init;
				init.children.add(child);
			}
		}
		this.children.clear();

		for (const fd of [...this.context.descriptors.keys()]) {
			try {
				fs.closeSync.call(this.context, fd);
			} catch {
				// A descriptor that is already gone is not worth failing an exit over
			}
		}

		this.parent?.children.delete(this);
		processes.delete(this.pid);
		if (this.context !== defaultContext) boundContexts.delete(this.pid);
	}

	public [Symbol.dispose](): void {
		this.dispose();
	}
}
