import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const assistant=readFileSync(new URL('../prompts/assistant.md',import.meta.url),'utf8');
const visual=readFileSync(new URL('../prompts/visual.md',import.meta.url),'utf8');
export const assistantInstructions=assistant;
export const visualInstructions=assistant+'\n\n'+visual;
export const instructionRevision=createHash('sha256').update(assistant).digest('hex');
