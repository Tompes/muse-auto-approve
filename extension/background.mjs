/*
** Service worker entry point. All logic lives in lib/worker.mjs.
*/
import { createWorker } from './lib/worker.mjs';

createWorker(chrome).start();
