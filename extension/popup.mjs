/*
** Popup entry point. All logic lives in lib/popup-view.mjs.
*/
import { startPopup } from './lib/popup-view.mjs';

startPopup({ document, chrome, fetch, setInterval });
