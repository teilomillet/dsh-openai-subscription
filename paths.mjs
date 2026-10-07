import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Account state is owned by the installation, outside distributable package files.
export const stateDirectory = resolve(process.env.DSH_OPENAI_HOME || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'openai-subscription'));
