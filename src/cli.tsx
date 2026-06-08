#!/usr/bin/env node
import { render } from 'ink';
import App from './app.js';
import { enterAltScreen, leaveAltScreen } from './screen.js';

enterAltScreen();

const { waitUntilExit } = render(<App />, { exitOnCtrlC: false });

// Restore the user's terminal no matter how we leave.
const restore = () => leaveAltScreen();
process.on('exit', restore);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

waitUntilExit().then(() => {
  leaveAltScreen();
  process.exit(0);
});
