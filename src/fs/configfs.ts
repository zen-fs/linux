// SPDX-License-Identifier: LGPL-3.0-or-later
import type { CreationOptions, Inode, InodeLike } from '@zenfs/core';
import { basename, dirname, join, relative } from '@zenfs/core/path';
import { withErrno } from 'kerium';
import { kernel_kobj, sysfs_create_mount_point } from '../kobject.js';
import { KernelFS } from './kernfs.js';

/** `/sys/kernel/config`, the empty directory this is mounted over */
sysfs_create_mount_point(kernel_kobj, 'config');

/**
 * A file on an item, i.e. `struct configfs_attribute`.
 * These are the only things in configfs userspace can read and write.
 */
export interface ConfigAttribute {
	/** Set when the attribute is added to an item */
	name?: string;
	/** @default 0o644 */
	mode: number;
	show?(): string;
	store?(value: string): void;
}

/** Anything that can show up in a configfs directory */
export type ConfigEntry = ConfigItem | ConfigLink | ConfigAttribute;

/** A directory in configfs, i.e. `struct config_item`. */
export class ConfigItem {
	public readonly mode: number = 0o755;

	/** The group this item is in, set when it is linked in */
	public parent?: ConfigGroup;

	public readonly attributes = new Map<string, ConfigAttribute>();

	/** Symlinks pointing at this item. It can't be removed while there are any. */
	public readonly links = new Set<ConfigLink>();

	public constructor(public name: string) {}

	/** The path of this item, relative to the root of configfs */
	public get path(): string {
		if (!this.parent) return '/';
		const parent = this.parent.path;
		return (parent == '/' ? '' : parent) + '/' + this.name;
	}

	public lookup(name: string): ConfigEntry | undefined {
		return this.attributes.get(name);
	}

	public keys(): Iterable<string> {
		return this.attributes.keys();
	}

	link(parent: ConfigGroup): void {
		this.parent = parent;
		parent.children.set(this.name, this);
	}

	unlink() {
		if (!this.parent) return;

		if (this.parent.children.get(this.name) === this) this.parent.children.delete(this.name);
		if (this instanceof ConfigGroup) this.parent.default_groups.delete(this);
		this.parent = undefined;
	}

	_detachPrep() {
		if (this.links.size) throw withErrno('EBUSY');
		if (!(this instanceof ConfigGroup)) return;

		for (const child of this.children.values()) {
			// Default groups go with their parent, so they only have to be empty themselves
			if (child instanceof ConfigGroup && this.default_groups.has(child)) {
				child._detachPrep();
				continue;
			}

			throw withErrno('ENOTEMPTY');
		}
	}

	public detach() {
		if (this instanceof ConfigGroup) {
			for (const group of [...this.default_groups]) group.detach();
			for (const child of [...this.children.values()]) if (child instanceof ConfigLink) child.drop();
		}

		for (const link of [...this.links]) link.drop();

		const parent = this.parent;
		parent?.disconnect_notify?.(this);
		this.unlink();
		parent?.drop_item?.(this);
		this.release?.();
	}

	/**
	 * @param mode Defaults based on which of `show` and `store` were passed.
	 */
	public create_attribute(
		name: string,
		show?: ((item: this) => string) | null,
		store?: ((item: this, value: string) => void) | null,
		mode: number = store ? (show ? 0o644 : 0o200) : 0o444
	): ConfigAttribute {
		if (this.lookup(name)) throw withErrno('EEXIST');

		const attr: ConfigAttribute = {
			name,
			mode,
			show: show ? () => show(this) : undefined,
			store: store ? (value: string) => store(this, value) : undefined,
		};

		this.attributes.set(name, attr);
		return attr;
	}

	/** `ct_item_ops->release`: this item is gone, let go of whatever it was holding */
	public release?(): void;

	/**
	 * `ct_item_ops->allow_link`: something is about to be symlinked into this item.
	 * Throw to refuse; an item without this can't be linked into at all.
	 */
	public allow_link?(target: ConfigItem): void;

	/** `ct_item_ops->drop_link`: a symlink into this item went away */
	public drop_link?(target: ConfigItem): void;
}

/**
 * An item that can hold other items, i.e. `struct config_group`.
 */
export class ConfigGroup extends ConfigItem {
	public readonly children = new Map<string, ConfigItem | ConfigLink>();

	/** Children the kernel made, which userspace can't `rmdir`. This is `default_groups`. */
	public readonly default_groups = new Set<ConfigGroup>();

	public override lookup(name: string): ConfigEntry | undefined {
		return this.children.get(name) ?? super.lookup(name);
	}

	public override keys(): Iterable<string> {
		return new Set([...this.children.keys(), ...this.attributes.keys()]);
	}

	public addDefaultGroup(child: ConfigGroup) {
		if (this.lookup(child.name)) throw withErrno('EEXIST');
		child.link(this);
		this.default_groups.add(child);
	}

	public removeDefaultGroups() {
		for (const child of [...this.default_groups]) child.detach();
	}

	registerGroup(group: ConfigGroup) {
		if (this.lookup(group.name)) throw withErrno('EEXIST');
		group.link(this);
	}

	/**
	 * Put a subsystem at the top level of configfs, i.e. `/sys/kernel/config/<name>`.
	 */
	registerSubsystem(): void {
		if (configfs_root.children.has(this.name)) throw withErrno('EEXIST');
		this.link(configfs_root);
	}

	unregisterSubsystem(): void {
		if (this.parent !== configfs_root) throw withErrno('EINVAL');
		this.detach();
	}

	findItem(name: string): ConfigItem | undefined {
		const child = this.children.get(name);
		return child instanceof ConfigItem ? child : undefined;
	}

	/** `ct_group_ops->make_item`: userspace ran `mkdir`. Throw to refuse. */
	public make_item?(name: string): ConfigItem;

	/** `ct_group_ops->make_group`, tried before `make_item` the way Linux tries it */
	public make_group?(name: string): ConfigGroup;

	/** `ct_group_ops->disconnect_notify`, called before the item is unlinked */
	public disconnect_notify?(item: ConfigItem): void;

	/** `ct_group_ops->drop_item`: userspace ran `rmdir` */
	public drop_item?(item: ConfigItem): void;
}

/**
 * A symlink from one item to another, which is how configfs expresses a relationship between two things userspace made.
 */
export class ConfigLink {
	public constructor(
		public readonly name: string,
		public readonly parent: ConfigGroup,
		/** Set once the target has been written, since `@zenfs/core` makes a symlink in two steps */
		public target?: ConfigItem
	) {
		parent.children.set(name, this);
	}

	public get path(): string {
		const parent = this.parent.path;
		return (parent == '/' ? '' : parent) + '/' + this.name;
	}

	/** A link that is still being made is a plain file, so it gets a plain file's permissions */
	public get mode(): number {
		return this.target ? 0o777 : 0o644;
	}

	public get contents(): string {
		return this.target ? relative(this.parent.path, this.target.path) : '';
	}

	drop() {
		if (this.parent.children.get(this.name) === this) this.parent.children.delete(this.name);
		if (!this.target) return;
		this.target.links.delete(this);
		this.parent.drop_link?.(this.target);
		this.target = undefined;
	}
}

/**
 * The root of configfs, which holds the registered subsystems.
 * @internal
 */
export const configfs_root: ConfigGroup = new ConfigGroup('');

/**
 * A place for userspace to build kernel objects by making directories, the other half of sysfs.
 * @see https://www.kernel.org/doc/html/latest/filesystems/configfs.html
 */
export class ConfigFS extends KernelFS<ConfigItem, ConfigAttribute, ConfigLink> {
	public constructor() {
		super(0x62656570, 'configfs');
	}

	protected lookup(path: string): ConfigEntry | null {
		let current: ConfigEntry = configfs_root;

		for (const part of path.split('/').filter(p => p)) {
			if (current instanceof ConfigLink) current = current.target ?? current;

			if (!(current instanceof ConfigItem)) throw withErrno('ENOTDIR');

			const next = current.lookup(part);
			if (!next) return null;
			current = next;
		}

		return current;
	}

	protected is_dir(entry: ConfigEntry): entry is ConfigItem {
		return entry instanceof ConfigItem;
	}

	protected is_link(entry: ConfigEntry): entry is ConfigLink {
		return entry instanceof ConfigLink && entry.target !== undefined;
	}

	protected override store(entry: ConfigEntry, value: string): void {
		if (!this.is_link(entry)) {
			super.store(entry, value);
			return;
		}

		if (entry.target) throw withErrno('EPERM');

		try {
			let target = value.trim();

			if (target.startsWith('/')) {
				const mount = this._mountPoint ?? '/sys/kernel/config';
				if (target != mount && !target.startsWith(mount + '/')) throw withErrno('EPERM');
				target = target.slice(mount.length) || '/';
			} else {
				target = join(entry.parent.path, target);
			}

			const item = this.lookup(target);
			if (!item) throw withErrno('ENOENT');
			if (!(item instanceof ConfigItem)) throw withErrno('EPERM');

			entry.parent.allow_link!(item);

			entry.target = item;
			item.links.add(entry);
		} catch (e) {
			entry.parent.children.delete(entry.name);
			this._forget(entry.path);
			throw e;
		}
	}

	public override mkdirSync(path: string): InodeLike {
		const parent = this._lookup(dirname(path));
		if (!(parent instanceof ConfigItem)) throw withErrno('ENOTDIR');

		const name = basename(path);
		if (parent.lookup(name)) throw withErrno('EEXIST');

		// "Lack-of-mkdir returns -EPERM"
		if (!(parent instanceof ConfigGroup) || (!parent.make_group && !parent.make_item)) throw withErrno('EPERM');

		const item = parent.make_group ? parent.make_group(name) : parent.make_item!(name);

		// The directory is named after what `mkdir` asked for, whatever the callback called the item
		item.name = name;
		item.link(parent);

		return this._getInode(path, item);
	}

	public override rmdirSync(path: string): void {
		const item = this._lookup(path);
		if (!(item instanceof ConfigItem)) throw withErrno('ENOTDIR');
		if (item.parent && item instanceof ConfigGroup && item.parent.default_groups.has(item)) throw withErrno('EPERM');

		item.detach();
		this._forget(path);
	}

	/**
	 * The only thing userspace can create in configfs is a symlink, and `@zenfs/core` makes one by
	 * creating an empty file, writing the target to it, and then changing it into a link.
	 */
	public override createFileSync(path: string, _options: CreationOptions): InodeLike {
		const parent = this._lookup(dirname(path));
		if (!(parent instanceof ConfigGroup)) throw withErrno('EPERM');

		if (!parent.allow_link) throw withErrno('EPERM');

		const name = basename(path);
		if (parent.lookup(name)) throw withErrno('EEXIST');

		return this._getInode(path, new ConfigLink(name, parent));
	}

	public override unlinkSync(path: string): void {
		const entry = this._lookup(path);

		if (!(entry instanceof ConfigLink)) throw withErrno('EPERM');

		entry.drop();
		this._forget(path);
	}
}
