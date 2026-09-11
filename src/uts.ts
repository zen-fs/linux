// SPDX-License-Identifier: LGPL-3.0-or-later
import { _version } from '@zenfs/core';
import type { UtsNameFields } from '@zenfs/linux/uapi/abi';
import $pkg from '../package.json' with { type: 'json' };

/** The one UTS namespace, i.e. `init_uts_ns`. */
export const init_uts: UtsNameFields = {
	sysname: 'Linux',
	nodename: '(none)',
	release: $pkg.version,
	version: `@zenfs/linux (core ${_version})`,
	machine: 'wasm64',
	domainname: '(none)',
};

export function set_hostname(name: string): void {
	init_uts.nodename = name;
}

export function set_domainname(name: string): void {
	init_uts.domainname = name;
}
