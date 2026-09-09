import { struct, types as t } from 'memium';

export const SyscallData = struct('syscall_data', {
	id: t.uint32,
});
