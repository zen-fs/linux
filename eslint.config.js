import shared from '@zenfs/core/eslint';
import { defineConfig } from 'eslint/config';

// The shared config only knows about `src`; `uapi` is the same thing on the other side of the syscall
const [base, ...rest] = shared;

export default defineConfig(base, { ...base, name: 'ZenFS (uapi)', files: ['uapi/**/*.ts'] }, ...rest, {
	files: ['src/**/*.ts', 'uapi/**/*.ts', 'tests/**/*.ts'],
	name: 'Enable typed checking',
	languageOptions: {
		parserOptions: {
			projectService: true,
			tsconfigRootDir: import.meta.dirname,
		},
	},
});
