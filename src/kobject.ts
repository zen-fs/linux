// SPDX-License-Identifier: LGPL-3.0-or-later
import { S_IWUSR } from '@zenfs/core/constants';
import { basename, dirname, relative } from '@zenfs/core/path';
import { withErrno } from 'kerium';

/**
 * The root, before the binding for `sysfs_root` has been initialized.
 * @internal
 */
let root: KObject | undefined;

/**
 * Unlike Linux, we don't use ksets, ktypes, or attribute groups.
 */
export class KObject {
	public children = new Map<string, KEntry>();

	/**
	 * These attributes use the kobject's `show` and `store`.
	 */
	public attributes = new Map<string, Attribute>();

	constructor(
		public name: string,
		public parent?: KObject | null
	) {
		this.parent ||= root;
		this.parent?.children.set(name, this);
	}

	/**
	 * The path of this kobject, relative to the root of sysfs.
	 */
	get path(): string {
		if (!this.parent) return '/';
		const parent = this.parent.path;
		return (parent == '/' ? '' : parent) + '/' + this.name;
	}

	/**
	 * Resolve a single entry by name.
	 * Attributes that use this kobject's `show` and `store` are bound before being returned.
	 */
	lookup(name: string): KEntry | undefined {
		const child = this.children.get(name);
		if (child) return child;

		const attr = this.attributes.get(name);
		if (!attr) return;

		const bound: Attribute = { ...attr, name };
		if (this.show) bound.show = () => this.show!(attr);
		if (this.store) bound.store = value => this.store!(attr, value);
		return bound;
	}

	/**
	 * The names of everything in this kobject.
	 */
	entries(): string[] {
		return [...new Set([...this.children.keys(), ...this.attributes.keys()])];
	}

	dispose() {
		for (const child of [...this.children.values()]) {
			if (child instanceof KObject || child instanceof KLink) child.dispose();
		}
		this.children.clear();
		this.parent?.children.delete(this.name);
	}

	[Symbol.dispose]() {
		this.dispose();
	}

	show?(attr: Attribute): string;
	store?(attr: Attribute, value: string): void;

	/**
	 * Notify listeners that something happened to `kobj`.
	 */
	notify_uevent(action: UEventAction, env: UEventEnv = {}): void {
		const event: UEvent = {
			action,
			kobject: this,
			path: this.path,
			env: { ACTION: action, DEVPATH: this.path, ...env },
		};

		const ancestors: KObject[] = [];
		for (let current: KObject | null | undefined = this; current; current = current.parent) ancestors.unshift(current);
		for (const ancestor of ancestors) ancestor.uevent?.(event.env);
		for (const listener of uevent_listeners) listener(event);
	}

	/**
	 * Send a uevent described by `text`, an action optionally followed by `KEY=VALUE` pairs.
	 * This is what writing to a `uevent` attribute does.
	 */
	send_uevent(text: string): void {
		const [action, ...vars] = text.trim().split(/\s+/) as [UEventAction, ...string[]];

		if (!uevent_actions.includes(action)) throw withErrno('EINVAL');

		const env: UEventEnv = {};
		for (const pair of vars) {
			const i = pair.indexOf('=');
			if (i < 1) throw withErrno('EINVAL');
			env[pair.slice(0, i)] = pair.slice(i + 1);
		}

		this.notify_uevent(action, env);
	}

	add_uevent_attr() {
		this.children.set('uevent', {
			name: 'uevent',
			mode: S_IWUSR,
			store: value => this.send_uevent(value),
		} satisfies Attribute);
	}

	/**
	 * Add variables to the environment of uevents sent for this kobject and its descendants.
	 * @see notify_uevent
	 */
	uevent?(env: UEventEnv): void;

	/**
	 * @param mode Defaults based on which of `show` and `store` were passed.
	 */
	create_attribute(
		name: string,
		show?: ((kobj: KObject) => string) | null,
		store?: ((kobj: KObject, value: string) => void) | null,
		mode: number = store ? (show ? 0o644 : 0o200) : 0o444
	): Attribute {
		if (this.lookup(name)) throw withErrno('EEXIST');

		const attr: Attribute = {
			name,
			mode,
			show: show ? () => show(this) : undefined,
			store: store ? (value: string) => store(this, value) : undefined,
		};

		this.children.set(name, attr);
		return attr;
	}
}

/**
 * The root of sysfs. Kobjects created without a parent end up here.
 * @internal
 */
export const sysfs_root: KObject = (root = new KObject(''));

export interface Attribute {
	/** The name of the attribute, set when it is added to a kobject. */
	name?: string;
	/** @default 0o444 */
	mode: number;
	show?(): string;
	store?(value: string): void;
}

export interface KObjectAttribute extends Attribute {}

/**
 * A symbolic link between kobjects, for example `/sys/module/some_module/holders/other_module`.
 * Like on Linux, links are always relative to the directory they are in.
 */
export class KLink {
	constructor(
		public readonly name: string,
		public readonly parent: KObject,
		public readonly target: KObject
	) {
		parent.children.set(name, this);
	}

	get path(): string {
		const parent = this.parent.path;
		return (parent == '/' ? '' : parent) + '/' + this.name;
	}

	get contents(): string {
		return relative(this.parent.path, this.target.path);
	}

	dispose() {
		if (this.parent.children.get(this.name) === this) this.parent.children.delete(this.name);
	}

	[Symbol.dispose]() {
		this.dispose();
	}
}

/** Anything that can show up in a sysfs directory */
export type KEntry = KObject | KLink | Attribute;

/**
 * Resolve a sysfs path.
 * @returns `null` if nothing exists at `path`
 * @throws ENOTDIR when part of `path` is used as a directory but isn't a kobject
 */
export function sysfs_lookup(path: string): KEntry | null {
	let current: KEntry = sysfs_root;

	for (const part of path.split('/').filter(p => p)) {
		if (!(current instanceof KObject)) throw withErrno('ENOTDIR');

		const next = current.lookup(part);
		if (!next) return null;
		current = next;
	}

	return current;
}

export function kobj_create(path: string): KObject {
	const parent = sysfs_lookup(dirname(path));
	if (!parent) throw withErrno('ENOENT');
	if (!(parent instanceof KObject)) throw withErrno('ENOTDIR');

	const name = basename(path);
	if (parent.lookup(name)) throw withErrno('EEXIST');

	return new KObject(name, parent);
}

export function sysfs_create_link(parent: KObject, target: KObject, name: string = target.name): KLink {
	if (parent.lookup(name)) throw withErrno('EEXIST');
	return new KLink(name, parent, target);
}

export function sysfs_remove_link(parent: KObject, name: string): void {
	const link = parent.children.get(name);
	if (link instanceof KLink) link.dispose();
}

/**
 * The environment of a uevent. Like Linux's `struct kobj_uevent_env`, values are always strings.
 */
export type UEventEnv = Record<string, string>;

export const uevent_actions = ['add', 'remove', 'change', 'move', 'online', 'offline', 'bind', 'unbind'] as const;

export type UEventAction = (typeof uevent_actions)[number];

export interface UEvent {
	action: UEventAction;
	kobject: KObject;
	/** The path of `kobject`, relative to the root of sysfs */
	path: string;
	env: UEventEnv;
}

export type UEventListener = (event: UEvent) => unknown;

export const uevent_listeners = new Set<UEventListener>();

export function kobj_init() {
	new KObject('block', null);
	new KObject('class', null);

	new KObject('drivers', null);
	new KObject('firmware', null);
	new KObject('hypervisor', null);
	new KObject('kernel', null);
}
