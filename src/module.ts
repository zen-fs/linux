// SPDX-License-Identifier: LGPL-3.0-or-later
import { withErrno } from 'kerium';
import { pick } from 'utilium';
import type { Attribute } from './kobject.js';
import { KObject, sysfs_create_link, sysfs_remove_link } from './kobject.js';
import { parse_param, type ParamValue, type ParamValueToType } from './param.js';

/**
 * The lifecycle state of a module.
 * These correspond to Linux's `MODULE_STATE_*`. `init` is `COMING` and `exit` is `GOING`.
 */
export type ModuleState = 'live' | 'init' | 'exit' | 'unformed';

/** What `initstate` shows for each state. Linux doesn't have a name for `unformed`. */
const initstate_names = {
	live: 'live',
	init: 'coming',
	exit: 'going',
	unformed: 'unknown',
} as const satisfies Record<ModuleState, string>;

/**
 * The taint flags a module can have, keyed by the character used by `taint` and `/proc/modules`.
 */
export const module_taints = {
	P: 'proprietary',
	F: 'forced load',
	C: 'staging',
	E: 'unsigned',
	O: 'out-of-tree',
} as const;

export type ModuleTaint = keyof typeof module_taints;

export interface KernelParamInit<T extends ParamValue = ParamValue> {
	/** The initial value. Its type determines how the parameter is parsed and formatted. */
	value: T;
	/**
	 * The mode of the parameter's file in `/sys/module/<name>/parameters`.
	 * A mode of 0 means the parameter isn't exposed through sysfs at all.
	 * @default 0o644
	 */
	mode?: number;
	/** Called after the parameter has been changed through sysfs */
	changed?: (value: T, param: KernelParam<T>) => void;
}

/**
 * A module parameter, analogous to `module_param` or `kernel_param` on Linux.
 * Parameters are attributes, so they show up in `/sys/module/<name>/parameters`.
 */
export class KernelParam<T extends ParamValue = ParamValue> implements Attribute {
	public readonly mode: number;

	protected _value: T;

	protected readonly type: ParamValueToType<T>;

	protected readonly changed?: (value: T, param: KernelParam<T>) => void;

	constructor(
		public readonly module: Module,
		public readonly name: string,
		init: KernelParamInit<T>
	) {
		this._value = init.value;
		this.type = typeof init.value as ParamValueToType<T>;
		this.mode = init.mode ?? 0o644;
		this.changed = init.changed;
	}

	get value(): T {
		return this._value;
	}

	set value(value: T) {
		if (typeof value !== this.type) throw withErrno('EINVAL');
		this._value = value;
	}

	show(): string {
		return (this.type == 'boolean' ? (this._value ? 'Y' : 'N') : this._value.toString()) + '\n';
	}

	store(text: string): void {
		if (!(this.mode & 0o222)) throw withErrno('EPERM');
		this.value = parse_param(this.type, text) as T;
		this.changed?.(this._value, this);
	}
}

/** `/sys/module` */
const modules_kobj = new KObject('module', null);

/**
 * The kobject for a module, i.e. `/sys/module/<name>`.
 * Like on Linux, `drivers` and `parameters` are only created once something goes in them.
 */
export class ModuleKObject extends KObject {
	/** `/sys/module/<name>/holders`, which has a link for every module using this one */
	public readonly holders: KObject = new KObject('holders', this);

	constructor(public readonly module: Module) {
		super(module.name, modules_kobj);
		this.add_uevent_attr();
	}

	#drivers?: KObject;

	/** `/sys/module/<name>/drivers` */
	get drivers(): KObject {
		this.#drivers ??= new KObject('drivers', this);
		return this.#drivers;
	}

	#parameters?: KObject;

	/** `/sys/module/<name>/parameters` */
	get parameters(): KObject {
		this.#parameters ??= new KObject('parameters', this);
		return this.#parameters;
	}
}

export interface ModuleInit {
	name: string;
	version?: string;
	srcversion?: string;
	license?: string;
	description?: string;
	author?: string | string[];
	/** Parameters exposed in `/sys/module/<name>/parameters` */
	params?: Record<string, KernelParamInit>;
	/** Taint flags to apply when the module is loaded */
	taints?: Iterable<ModuleTaint>;
	/** Called when the module is loaded. If this throws, the module isn't loaded. */
	init?: (this: Module) => void | Promise<void>;
	/** Called when the module is unloaded */
	exit?: (this: Module) => void | Promise<void>;
}

export class Module implements AsyncDisposable {
	public readonly name!: string;
	public readonly version?: string;
	public readonly srcversion?: string;
	public readonly license?: string;
	public readonly description?: string;
	public readonly author?: string | string[];

	protected readonly _init?: (this: Module) => void | Promise<void>;
	protected readonly _exit?: (this: Module) => void | Promise<void>;

	#state: ModuleState = 'unformed';

	get state(): ModuleState {
		return this.#state;
	}

	set state(value: ModuleState) {
		this.#state = value;
		for (const notifier of module_notifiers) notifier(value, this);
	}

	public readonly kobject: ModuleKObject;

	public readonly params = new Map<string, KernelParam>();

	/** Modules this one depends on */
	public readonly uses = new Set<Module>();

	/** Modules that depend on this one */
	public readonly holders = new Set<Module>();

	public readonly taints = new Set<ModuleTaint>();

	/**
	 * The number of references held on this module.
	 * @internal
	 */
	public _refs = 0;

	/** The number of references held on this module, including the ones held by `holders` */
	get refcnt(): number {
		return this._refs;
	}

	/**
	 * Note this only sets the module up. Use `init` to actually load it.
	 */
	constructor(init: ModuleInit) {
		if (!init.name) throw withErrno('EINVAL');
		if (module_list.has(init.name)) throw withErrno('EEXIST');

		Object.assign(this, pick(init, 'name', 'version', 'srcversion', 'license', 'description', 'author'));
		this._init = init.init;
		this._exit = init.exit;

		for (const taint of init.taints ?? []) this.taints.add(taint);

		this.kobject = new ModuleKObject(this);

		const attrs = this.kobject.children;
		attrs.set('initstate', { name: 'initstate', mode: 0o444, show: () => initstate_names[this.state] + '\n' });
		attrs.set('refcnt', { name: 'refcnt', mode: 0o444, show: () => this.refcnt + '\n' });
		attrs.set('taint', { name: 'taint', mode: 0o444, show: () => this.flags + '\n' });

		if (this.version !== undefined) attrs.set('version', { name: 'version', mode: 0o444, show: () => this.version + '\n' });
		if (this.srcversion !== undefined) attrs.set('srcversion', { name: 'srcversion', mode: 0o444, show: () => this.srcversion + '\n' });

		for (const [name, param_init] of Object.entries(init.params ?? {})) {
			const param = new KernelParam(this, name, param_init);
			this.params.set(name, param);
			if (param.mode) this.kobject.parameters.children.set(name, param);
		}

		module_list.set(this.name, this);
	}

	/**
	 * Run `init`.
	 *
	 * Unlike Linux's `init_module(2)`, this is async since a module may need to do something
	 * asynchronous (like fetching a resource) before it is ready. The module is `init` until then.
	 *
	 * @throws Whatever `init` throws, after unloading the partially loaded module
	 */
	async init(): Promise<void> {
		this.state = 'init';

		try {
			await this._init?.();
		} catch (e) {
			this.state = 'exit';
			this.unlink();
			throw e;
		}

		this.state = 'live';
		this.kobject.notify_uevent('add', { MODULE: this.name });
	}

	/** Shorthand for `this.params.get(name)?.value` */
	param<T extends ParamValue = ParamValue>(name: string): T | undefined {
		return this.params.get(name)?.value as T | undefined;
	}

	/** The taint characters for a module, for example `OE` */
	get flags(): string {
		return [...this.taints].join('');
	}

	/**
	 * Take a reference on a module so it can't be unloaded.
	 * @returns whether the reference was taken
	 */
	try_ref() {
		if (this.state != 'live') return false;
		this._refs++;
		return true;
	}

	/** Like `try_ref`, but throws instead of returning `false` */
	ref() {
		if (!this.try_ref()) throw withErrno(this.state == 'init' ? 'EBUSY' : 'ENOENT');
	}

	unref() {
		if (this._refs > 0) this._refs--;
	}

	/**
	 * Depend on `target`.
	 * This takes a reference on `target` and adds a link in `/sys/module/<target>/holders`.
	 */
	use(target: Module): void {
		if (this === target || this.uses.has(target)) return;

		target.ref();

		this.uses.add(target);
		target.holders.add(this);
		sysfs_create_link(target.kobject.holders, this.kobject, this.name);
	}

	/** Undo `use` */
	unuse(target: Module): void {
		if (!this.uses.delete(target)) return;

		target.holders.delete(this);
		sysfs_remove_link(target.kobject.holders, this.name);
		target.unref();
	}

	/**
	 * Remove from the list and tear down sysfs entries.
	 */
	protected unlink() {
		for (const used of [...this.uses]) this.unuse(used);
		for (const holder of [...this.holders]) holder.unuse(this);
		module_list.delete(this.name);
		this.kobject.dispose();
	}

	/**
	 * Unload a module, analogous to `delete_module(2)`.
	 * @param force Unload even when the module is still referenced. This taints the module with `F`.
	 * @throws EBUSY if the module isn't live, or is still referenced and `force` isn't set
	 */
	async dispose(force: boolean = false): Promise<void> {
		if (!this) throw withErrno('ENOENT');

		if (this.state != 'live') throw withErrno('EBUSY');

		if (this.refcnt) {
			if (!force) throw withErrno('EBUSY');
			this.taints.add('F');
		}

		this.state = 'exit';
		this.kobject.notify_uevent('remove', { MODULE: this.name });

		await this._exit?.();

		this.unlink();
	}

	[Symbol.asyncDispose]() {
		return this.dispose();
	}
}

const module_list = new Map<string, Module>();

/** Every module that currently exists, including ones that aren't live yet */
export const modules: ReadonlyMap<string, Module> = module_list;

export function find_module(name: string): Module | null {
	return module_list.get(name) ?? null;
}

export type ModuleNotifier = (state: ModuleState, mod: Module) => unknown;

export const module_notifiers = new Set<ModuleNotifier>();
