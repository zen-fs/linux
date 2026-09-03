import { configure, defaultContext, InMemory } from '@zenfs/core';
import { withErrno } from 'kerium';
import type { Level as LogLevel } from 'kerium/log';
import { emerg, err, fancy, info, Level, warn } from 'kerium/log';
import { encodeUTF8, type WithRequired } from 'utilium';
import { driver_init } from './drivers/base/init.js';
import { char_dev_init } from './drivers/char/mem.js';
import { of_platform_populate } from './drivers/of/device_tree.js';
import { console_tty } from './drivers/tty/console.js';
import { tty } from './drivers/tty/index.js';
import { web_storage } from './drivers/webstorage/index.js';
import { ConfigFS } from './fs/configfs.js';
import { DebugFS } from './fs/debugfs.js';
import { DevTmpFS } from './fs/devtmpfs.js';
import { execve } from './fs/exec.js';
import { ProcFS } from './fs/procfs.js';
import { SysFS } from './fs/sysfs.js';
import { kobj_init } from './kobject.js';
import { find_module } from './module.js';
import { Process } from './process.js';

/** Where init might be. These are tried in order, the same ones `kernel_init` falls back to. */
const init_paths: string[] = ['/sbin/init', '/etc/init', '/bin/init', '/bin/sh'];

export interface InitOptions {
	/**
	 * The kernel command line, e.g. `init=/bin/sh quiet tty.probe=0 HOME=/root`.
	 * This is what `/proc/cmdline` shows, and it overrides the rest of these.
	 */
	cmdline?: string;
	init?: string;
	argv?: string[];
	env?: Record<string, string>;
	quiet?: boolean;
	loglevel?: LogLevel;
}

export interface InitConfig extends WithRequired<InitOptions, 'argv' | 'env' | 'loglevel'> {
	_saved: string;
}

export const initConfig: InitConfig = {
	_saved: '',
	argv: ['init'],
	env: { HOME: '/', TERM: 'linux' },
	loglevel: Level.INFO,
};

/** What `quiet` turns the console down to, i.e. `CONSOLE_LOGLEVEL_QUIET` */
const loglevel_quiet = Level.ERR;

/** One argument: a run of non-space characters, with anything in quotes kept together */
const arg_pattern = /(?:[^\s"]|"[^"]*")+/g;

/**
 * Parameters the kernel itself handles. Linux registers these with `__setup` and `early_param`.
 * @returns whether the parameter was one of them
 */
function known_param(param: string, val?: string): boolean {
	switch (param) {
		case 'init':
			initConfig.init = val;
			initConfig.argv.length = 1;
			return true;
		case 'quiet':
			initConfig.loglevel = loglevel_quiet;
			return true;
		case 'debug':
			initConfig.loglevel = Level.DEBUG;
			return true;
		case 'loglevel': {
			const level = Number(val);
			// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison
			if (!Number.isInteger(level) || level < Level.EMERG || level > Level.DEBUG) {
				warn(`Malformed early option 'loglevel'`);
				return true;
			}
			initConfig.loglevel = level;
			return true;
		}
	}

	return false;
}

/** `<module>.<param>=<value>`, which `parse_args` hands to the module it names */
function module_param(param: string, val: string = '1'): void {
	const dot = param.indexOf('.');
	const module = find_module(param.slice(0, dot));

	// Linux lets these through for modules that aren't loaded yet
	if (!module) return;

	const name = param.slice(dot + 1);
	const kp = module.params.get(name);
	if (!kp) {
		warn(`${module.name}: unknown parameter '${name}' ignored`);
		return;
	}

	try {
		kp.store(val);
	} catch {
		warn(`${module.name}: '${val}' invalid for parameter '${name}'`);
	}
}

/**
 * Work through the kernel command line, i.e. `parse_args` with `unknown_bootoption`.
 *
 * Anything the kernel doesn't recognize is init's: with a value it becomes an environment variable,
 * without one it becomes an argument. Everything after `--` is an argument no matter what.
 */
export function parse_cmdline(cmdline: string): void {
	initConfig._saved = cmdline;

	let after_dashes = false;

	for (const raw of cmdline.match(arg_pattern) ?? []) {
		if (raw == '--') {
			after_dashes = true;
			continue;
		}

		// Quotes only hold an argument together, they aren't part of it
		const arg = raw.replaceAll('"', '');

		if (after_dashes) {
			initConfig.argv.push(arg);
			continue;
		}

		const eq = arg.indexOf('=');
		const param = eq < 0 ? arg : arg.slice(0, eq);
		const val = eq < 0 ? undefined : arg.slice(eq + 1);

		if (known_param(param, val)) continue;

		if (param.includes('.')) {
			module_param(param, val);
			continue;
		}

		if (val === undefined) initConfig.argv.push(arg);
		else initConfig.env[param] = val;
	}
}

function code_of(e: unknown): string {
	return (e as { code?: string })?.code ?? String(e);
}

function panic(message: string): never {
	emerg('Kernel panic - not syncing: ' + message);
	throw withErrno('ENOEXEC', message);
}

/** Colors the host console can't render when it isn't a terminal */
// eslint-disable-next-line no-control-regex
const ansi = /\x1b\[[0-9;]*m/g;

/** Messages logged before there was a console to put them on, i.e. what the printk ring buffer holds */
const pending: string[] = [];

function kernel_log(...message: string[]): void {
	const text = message.join(' ');

	console.log('process' in globalThis ? text : text.replace(ansi, ''));

	if (!console_tty) {
		pending.push(text);
		return;
	}

	flush_kernel_log();
	console_tty.write(encodeUTF8(text + '\n'));
}

/** Give a console everything logged before it existed, i.e. what `register_console` replays */
function flush_kernel_log(): void {
	if (!console_tty) return;
	for (const line of pending.splice(0)) console_tty.write(encodeUTF8(line + '\n'));
}

export async function init(options: InitOptions = {}): Promise<Process> {
	const { env, ...rest } = options;
	Object.assign(initConfig, rest);
	Object.assign(initConfig.env, env);
	if (options.quiet) initConfig.loglevel = loglevel_quiet;

	parse_cmdline(options.cmdline ?? '');

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
			format: fancy({ colorize: 'message', style: 'ansi' }),
			level: initConfig.loglevel,
			output: kernel_log,
		},
	});

	if (initConfig._saved) info('Kernel command line: ' + initConfig._saved);

	of_platform_populate();

	// Built-in modules
	await tty.init();
	flush_kernel_log();
	await web_storage.init();

	const proc = new Process({ context: defaultContext, argv: initConfig.argv, env: { ...initConfig.env } });

	function run_init_process(filename: string): void {
		info(`Run ${filename} as init process`);
		execve(proc, filename, [filename, ...initConfig.argv.slice(1)], proc.env);
	}

	if (initConfig.init)
		try {
			run_init_process(initConfig.init);
			return proc;
		} catch (e) {
			panic(`Requested init ${initConfig.init} failed (${code_of(e)})`);
		}

	for (const filename of init_paths)
		try {
			run_init_process(filename);
			return proc;
		} catch (e) {
			if (code_of(e) != 'ENOENT') err(`Starting init: ${filename} exists but couldn't execute it (${code_of(e)})`);
		}

	panic('No working init found. Pass one with `init=`.');
}
