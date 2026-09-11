// SPDX-License-Identifier: LGPL-3.0-or-later
import { allowedRestrictedNames } from '@zenfs/core/vfs/xattr';
import type { FileCapabilities } from '@zenfs/linux/uapi/abi';
import { capabilityXattr } from '@zenfs/linux/uapi/abi';
import { withErrno } from 'kerium';
import type { Process } from './process.js';

// A file's capabilities live in an attribute the VFS would otherwise turn away as unsupported
allowedRestrictedNames.add(capabilityXattr);

/** `CAP_*`, with Linux's numbers */
export enum Cap {
	CHOWN = 0,
	DAC_OVERRIDE = 1,
	DAC_READ_SEARCH = 2,
	FOWNER = 3,
	FSETID = 4,
	KILL = 5,
	SETGID = 6,
	SETUID = 7,
	SETPCAP = 8,
	LINUX_IMMUTABLE = 9,
	NET_BIND_SERVICE = 10,
	NET_BROADCAST = 11,
	NET_ADMIN = 12,
	NET_RAW = 13,
	IPC_LOCK = 14,
	IPC_OWNER = 15,
	SYS_MODULE = 16,
	SYS_RAWIO = 17,
	SYS_CHROOT = 18,
	SYS_PTRACE = 19,
	SYS_PACCT = 20,
	SYS_ADMIN = 21,
	SYS_BOOT = 22,
	SYS_NICE = 23,
	SYS_RESOURCE = 24,
	SYS_TIME = 25,
	SYS_TTY_CONFIG = 26,
	MKNOD = 27,
	LEASE = 28,
	AUDIT_WRITE = 29,
	AUDIT_CONTROL = 30,
	SETFCAP = 31,
	MAC_OVERRIDE = 32,
	MAC_ADMIN = 33,
	SYSLOG = 34,
	WAKE_ALARM = 35,
	BLOCK_SUSPEND = 36,
	AUDIT_READ = 37,
	PERFMON = 38,
	BPF = 39,
	CHECKPOINT_RESTORE = 40,
}

/** `CAP_LAST_CAP` */
export const cap_last: Cap = Cap.CHECKPOINT_RESTORE;

/** `CAP_FULL_SET` */
export const cap_full: bigint = (1n << BigInt(cap_last + 1)) - 1n;

/** `CAP_EMPTY_SET` */
export const cap_empty: bigint = 0n;

/** `CAP_TO_MASK`, i.e. the bit one capability takes in a set */
export function cap_bit(cap: Cap): bigint {
	return 1n << BigInt(cap);
}

/** The name `capsh` and friends print a capability by, e.g. `cap_sys_admin` */
export function cap_name(cap: Cap): string {
	return 'cap_' + (Cap[cap]?.toLowerCase() ?? String(cap));
}

/**
 * The five capability sets a process carries, i.e. the capability half of `struct cred`.
 */
export interface Capabilities {
	effective: bigint;
	permitted: bigint;
	inheritable: bigint;
	bounding: bigint;
	ambient: bigint;
}

/** What `init_cred` starts with: everything, minus the two sets that only ever grow deliberately. */
export function initial_capabilities(): Capabilities {
	return { effective: cap_full, permitted: cap_full, inheritable: cap_empty, bounding: cap_full, ambient: cap_empty };
}

export function copy_capabilities(from: Capabilities): Capabilities {
	return { ...from };
}

/**
 * What `cap_bprm_creds_from_file` works out for a new image.
 */
export function capabilities_on_exec(caps: Capabilities, euid: number, file?: FileCapabilities): Capabilities {
	const root = euid === 0;
	const fP = root ? cap_full : (file?.permitted ?? cap_empty);
	const fI = root ? cap_full : (file?.inheritable ?? cap_empty);

	const permitted = (caps.bounding & fP) | (caps.inheritable & fI) | caps.ambient;
	const effective = root || file?.effective ? permitted : caps.ambient;

	return { ...caps, permitted, effective };
}

/** Whether the process may do something, i.e. `capable()` */
export function capable(proc: Process, cap: Cap): boolean {
	return (proc.caps.effective & cap_bit(cap)) !== 0n;
}

/** {@link capable}, for the callers that have nothing to say but `EPERM` */
export function require_capable(proc: Process, cap: Cap): void {
	if (!capable(proc, cap)) throw withErrno('EPERM', `${cap_name(cap)} is not in the effective set`);
}

/**
 * `cap_capset`: what a process is allowed to change its own sets to.
 */
export function cap_set(caps: Capabilities, to: Pick<Capabilities, 'effective' | 'permitted' | 'inheritable'>): Capabilities {
	if (to.permitted & ~caps.permitted) throw withErrno('EPERM', 'permitted set may not grow');
	if (to.effective & ~to.permitted) throw withErrno('EPERM', 'effective set may not exceed the permitted set');
	if (to.inheritable & ~(caps.inheritable | caps.permitted)) throw withErrno('EPERM', 'inheritable set may not grow');

	return { ...caps, effective: to.effective, permitted: to.permitted, inheritable: to.inheritable };
}
