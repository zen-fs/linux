# Terminals

The `tty` module is built in. Loading it registers `/dev/tty` (5:0) and `/dev/console` (5:1), then
looks for a terminal to point them at.

A terminal is split the way Linux splits one:

- **the driver** moves bytes to and from whatever the terminal really is
- **the line discipline** (`n_tty.ts`) does everything else: echo, line editing, turning `\n` into `\r\n`, etc.

So a driver only has to implement `write`, and call `TTY.receive` when someone types.

## Drivers

| Driver           | Node                       | Backed by                           |
| ---------------- | -------------------------- | ----------------------------------- |
| `console` (4:64) | `/dev/console0`            | the host's `process.stdout`/`stdin` |
| `xterm` (4:192+) | `/dev/xterm<n>`            | an xterm.js `Terminal`              |
| `tty` (5:0, 5:1) | `/dev/tty`, `/dev/console` | whichever terminal is the console   |

On Node the host's streams are found on their own, the way a driver probes for hardware.
In a browser there is nothing to find, so an xterm.js terminal has to be handed over:

```ts
import { attach_xterm } from '@zenfs/linux';
import { Terminal } from '@xterm/xterm';

const terminal = new Terminal();
terminal.open(document.getElementById('terminal')!);

const tty = attach_xterm(terminal); // `/dev/xterm0`

fs.writeFileSync('/dev/tty', 'hello\n');
```
