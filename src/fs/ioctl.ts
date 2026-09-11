// SPDX-License-Identifier: LGPL-3.0-or-later
import { InodeFlags } from '@zenfs/core/internal/inode';
import type { IoctlContext } from '@zenfs/core/internal/ioctl';
import { IOC, ioctl_default_ops_async, ioctl_default_ops_sync } from '@zenfs/core/internal/ioctl';
import type { FsxattrFields } from '@zenfs/linux/uapi/abi';
import { XFlag } from '@zenfs/linux/uapi/abi';
import { withErrno } from 'kerium';
import { KObject, sysfs_lookup } from '../kobject.js';

/** Each {@link XFlag} beside the inode flag that means the same thing */
const xFlagPairs = [
	[XFlag.Immutable, InodeFlags.Immutable],
	[XFlag.Append, InodeFlags.Append],
	[XFlag.Sync, InodeFlags.Sync],
	[XFlag.NoAtime, InodeFlags.NoAtime],
	[XFlag.Dax, InodeFlags.DAX],
	[XFlag.Verity, InodeFlags.Verity],
	[XFlag.CaseFold, InodeFlags.CaseFold],
] satisfies [XFlag, InodeFlags][];

export const kernel_ioctl_ops = {
	[IOC.GetXattr]($: IoctlContext): FsxattrFields {
		let xflags = 0;
		for (const [x, inode] of xFlagPairs) if (($.inode.flags || 0) & inode) xflags |= x;

		return { xflags, extsize: 0, nextents: 0, projid: 0, cowextsize: 0 };
	},
	[IOC.SetXattr]($: IoctlContext, attr: FsxattrFields): void {
		let supported = 0,
			settable = 0,
			value = 0;

		for (const [x, inode] of xFlagPairs) {
			supported |= x;
			settable |= inode;
			if (attr.xflags & x) value |= inode;
		}

		if (attr.xflags & ~supported) throw withErrno('ENOTSUP', 'Unsupported file attributes');
		if (attr.extsize || attr.projid || attr.cowextsize) throw withErrno('ENOTSUP', 'Extent sizes and projects are not supported');

		$.inode.flags = (($.inode.flags || 0) & ~settable) | value;
	},
	[IOC.GetSysfsPath]($: IoctlContext): string {
		const parent = sysfs_lookup('/fs');
		if (!(parent instanceof KObject)) throw withErrno('ENOTTY');
		const type = parent.lookup($.fs.name) ?? new KObject($.fs.name, parent);
		if (!(type instanceof KObject)) throw withErrno('ENOTTY');

		if (!type.lookup($.fs.uuid)) new KObject($.fs.uuid, type);

		return `${$.fs.name}/${$.fs.uuid}`;
	},
};

Object.assign(ioctl_default_ops_sync, kernel_ioctl_ops);
Object.assign(ioctl_default_ops_async, kernel_ioctl_ops);
