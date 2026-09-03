import { configure, defaultContext, InMemory } from '@zenfs/core';
import { withErrno } from 'kerium';
import { emerg, err, fancy, info } from 'kerium/log';
import { of_platform_populate } from './drivers/of/device_tree.js';
import { driver_init } from './drivers/base/init.js';
import { char_dev_init } from './drivers/char/mem.js';
import { tty } from './drivers/tty/index.js';
import { web_storage } from './drivers/webstorage/index.js';
import { ConfigFS } from './fs/configfs.js';
import { DebugFS } from './fs/debugfs.js';
import { DevTmpFS } from './fs/devtmpfs.js';
import { execve } from './fs/exec.js';
import { ProcFS } from './fs/procfs.js';
import { SysFS } from './fs/sysfs.js';
import { kobj_init } from './kobject.js';
import { Process } from './process.js';

/** What init is run with, i.e. `argv_init`. Whatever ends up being run replaces the first entry. */
const argv_init: string[] = ['init'];

/** The environment init is given, i.e. `envp_init` */
const envp_init: Record<string, string> = { HOME: '/', TERM: 'linux' };

/** Where init might be. These are tried in order, the same ones `kernel_init` falls back to. */
const init_paths: string[] = ['/sbin/init', '/etc/init', '/bin/init', '/bin/sh'];

export interface InitOptions {
	init?: string;
	argv?: string[];
	env?: Record<string, string>;
	quiet?: boolean;
}

function code_of(e: unknown): string {
	return (e as { code?: string })?.code ?? String(e);
}

function panic(message: string): never {
	emerg('Kernel panic - not syncing: ' + message);
	throw withErrno('ENOEXEC', message);
}

export async function init(options: InitOptions = {}): Promise<Process> {
	kobj_init();

	driver_init();

	// Linux does this from its own initcall, after the driver core is up
	// @todo implement initcall (init callbacks)?
	char_dev_init();

	await configure({
		mounts: {
			'/dev': new DevTmpFS(),
			'/proc': new ProcFS(),
			'/sys': new SysFS(),
			'/sys/kernel/config': new ConfigFS(),
			'/sys/kernel/debug': new DebugFS(),
			'/tmp': InMemory,
			'/run': InMemory,
		},
		defaultDirectories: true,
		log: {
			enabled: true,
			format: fancy({ colorize: 'message', style: 'process' in globalThis ? 'ansi' : 'css' }),
			level: 'debug',
			output: console.log,
		},
	});

	of_platform_populate();

	// Built-in modules
	await tty.init();
	await web_storage.init();

	const argv = options.argv ?? argv_init;

	const proc = new Process({ context: defaultContext, argv, env: { ...envp_init, ...options.env } });

	function run_init_process(filename: string): void {
		info(`Run ${filename} as init process`);
		execve(proc, filename, [filename, ...argv.slice(1)], proc.env);
	}

	if (options.init)
		try {
			run_init_process(options.init);
			return proc;
		} catch (e) {
			panic(`Requested init ${options.init} failed (${code_of(e)})`);
		}

	for (const filename of init_paths)
		try {
			run_init_process(filename);
			return proc;
		} catch (e) {
			if (code_of(e) != 'ENOENT') err(`Starting init: ${filename} exists but couldn't execute it (${code_of(e)})`);
		}

	panic('No working init found. Pass one with `init`.');
}
