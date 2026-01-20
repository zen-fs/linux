// SPDX-License-Identifier: LGPL-3.0-or-later
import { dirname } from '@zenfs/core/path.js';
import { withErrno } from 'kerium';

/**
 * @internal
 */
export const sysfs_root = new Map<string, KObject>();

/**
 * Unlike Linux, we don't use ksets, ktypes, or attribute groups.
 */
export class KObject {
	public children = new Map<string, Attribute | KObject>();

	/**
	 * These attributes use the kobject's `show` and `store`.
	 */
	public attributes = new Map<string, Attribute>();

	constructor(
		public name: string,
		public parent?: KObject | null
	) {
		if (!parent) {
			sysfs_root.set(name, this);
		} else {
			parent.children.set(name, this);
		}
	}

	dispose() {
		if (!this.parent) {
			sysfs_root.delete(this.name);
		} else {
			this.parent.children.delete(this.name);
		}
	}

	[Symbol.dispose]() {
		this.dispose();
	}

	show?(attr: Attribute): string;
	store?(attr: Attribute, value: string): void;
}

export interface Attribute<Args extends any[] = any[]> {
	/** @default 0o444 */
	mode: number;
	show?(...args: Args): string;
	store?(...args: [...Args, value: string]): void;
}

export interface KObjectAttribute extends Attribute<[KObject]> {}

export function kobj_find(path: string): KObject | Attribute | null {
	const [top_level, ...parts] = path.split('/').filter(p => p);
	let current: KObject | Attribute | undefined = sysfs_root.get(top_level);
	for (const part of parts) {
		if (!(current instanceof KObject)) throw withErrno('ENOTDIR');
		if (!current.children.has(part)) throw withErrno('ENOENT');

		current = current.children.get(part);
	}

	return current || null;
}

export function kobj_create(path: string): KObject {
	const parent = kobj_find(dirname(path));
	if (!parent) throw withErrno('ENOENT');
	if (!(parent instanceof KObject)) throw withErrno('ENOTDIR');

	if (parent.children.has(path)) throw withErrno('EEXIST');

	const name = path.split('/').pop()!;
	return new KObject(name, parent);
}

export function kobj_create_attribute(
	parent: KObject,
	name: string,
	show: KObjectAttribute['show'],
	store: KObjectAttribute['store'],
	mode: number = 0o444
): void {
	if (parent.children.has(name)) throw withErrno('EEXIST');
	parent.children.set(name, {
		mode,
		show,
		store,
	} as KObjectAttribute);
}

export function kobj_init() {
	new KObject('block', null);
	new KObject('class', null);

	new KObject('drivers', null);
	new KObject('firmware', null);
	new KObject('hypervisor', null);
	new KObject('kernel', null);
}
