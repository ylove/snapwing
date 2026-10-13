/** The console's entry point (#348): mounts the shell with the same-origin API client. */

import { render } from 'preact';
import { createApiClient } from './api.ts';
import { Shell } from './shell.tsx';
import './styles.css';

const root = document.getElementById('app');
if (root !== null) render(<Shell api={createApiClient()} />, root);
