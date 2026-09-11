// SPDX-License-Identifier: LGPL-3.0-or-later
/** The process and signal syscalls */
import { UtsName, write_utsname } from '@zenfs/linux/uapi/abi';
import { withErrno } from 'kerium';
import { execve, spawn } from '../fs/exec.js';
import type { Process } from '../process.js';
import { processes } from '../process.js';
import { signal_of } from '../signal.js';
import { init_uts, set_domainname, set_hostname } from '../uts.js';
import { define_syscall, thread_of } from './table.js';

define_syscall('getpid', proc => proc.pid);
define_syscall('getppid', proc => proc.ppid);
define_syscall('getuid', proc => proc.context.credentials.uid);
define_syscall('geteuid', proc => proc.context.credentials.euid);
define_syscall('getgid', proc => proc.context.credentials.gid);
define_syscall('getegid', proc => proc.context.credentials.egid);

define_syscall('exit', (proc, code) => {
	proc.exit(code);
});

define_syscall('spawn', async (proc, path, argv, env, cwd) => {
	const child = await spawn(proc, path, argv, env, { cwd });
	return child.pid;
});

/**
 * The thread does not survive this: a fresh image is a fresh thread, which is as close to what
 * `execve` does as there is here. Whatever it returns is written to a page nobody is reading.
 */
define_syscall('execve', async (proc, path, argv, env) => {
	await execve(proc, path, argv, env);
	return 0;
});

define_syscall('wait', (proc, pid) => proc.wait(pid));

define_syscall('setitimer', (proc, which, value, interval) => {
	const previous = proc.setitimer(which, value, interval);

	const { region } = thread_of(proc);
	const answer = new DataView(region.buffer, region.byteOffset);
	answer.setFloat64(0, previous.value, true);
	answer.setFloat64(8, previous.interval, true);
	thread_of(proc).filled(16);

	return 0;
});

define_syscall('kill', (proc, pid, signal) => {
	const target = processes.get(pid);
	if (!target) throw withErrno('ESRCH');

	// Linux checks that the sender is allowed to signal the target; here every process is the same user
	// @todo have multi-user support
	void proc;
	target.kill(signal_of(signal));
});

define_syscall('sigaction', (proc: Process, signal, caught) => {
	const sig = signal_of(signal);
	if (caught) proc.catch_signal(sig);
	else proc.uncatch_signal(sig);
});

define_syscall('uname', proc => {
	const { region } = thread_of(proc);
	region.fill(0, 0, UtsName.size);

	write_utsname(new UtsName(region.buffer, region.byteOffset), init_uts);

	return thread_of(proc).filled(UtsName.size);
});

/** What naming the system takes, standing in for `CAP_SYS_ADMIN` until there are capabilities */
// @todo add capabilities
function admin(proc: Process): void {
	if (proc.context.credentials.euid !== 0) throw withErrno('EPERM');
}

define_syscall('sethostname', (proc, name) => {
	admin(proc);
	set_hostname(name);
});

define_syscall('setdomainname', (proc, name) => {
	admin(proc);
	set_domainname(name);
});
