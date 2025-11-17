import { dirname } from '@zenfs/core/path.js';
import { withErrno } from 'kerium';

const root = new Map<string, KObject>();

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
		public parent: KObject | null
	) {
		if (!parent) {
			root.set(name, this);
		} else {
			parent.children.set(name, this);
		}
	}

	show?(attr: Attribute): string;
	store?(attr: Attribute, value: string): void;
}

export interface Attribute {
	/** @default 0o444 */
	mode: number;
}

export interface KObjectAttribute extends Attribute {
	show(kobj: KObject): string;
	store(kobj: KObject, value: string): void;
}

export function kobj_find(path: string): KObject | Attribute | null {
	const [group, ...parts] = path.split('/').filter(p => p);
	let current: KObject | Attribute | undefined = root.get(group);
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
	new KObject('bus', null);
	new KObject('class', null);

	new KObject('drivers', null);
	new KObject('firmware', null);
	new KObject('hypervisor', null);
	new KObject('kernel', null);
}
